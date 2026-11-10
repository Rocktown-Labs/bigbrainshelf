#!/usr/bin/env python3
"""Split each character's multi-pose sheet into individual pose crops.

Downloads the approved color sheets from the public R2 bucket, detects
poses by background subtraction + connected components (with a
projection-valley split for wide merged blobs), crops tight boxes in
reading order (left-to-right, top-to-bottom), uploads the crops to R2
under cast-gallery/{slug}/, and writes src/data/cast-gallery.json.

Usage: python3 scripts/extract-cast-poses.py [--local-only]
  --local-only: skip R2 upload (still writes crops + manifest locally)
"""
import io, json, os, sys, time, urllib.parse, urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage  # noqa: E402

ACCT = "5af47adc047fa74dcfa59048858b486c"
BUCKET = "kidsbook-factory"
R2_PUBLIC = "https://pub-5e76d8a2d35343dbaa517e251b84e9c5.r2.dev"
OUT_DIR = "/tmp/cast-poses"
MANIFEST = os.path.join(os.path.dirname(__file__), "..", "src", "data", "cast-gallery.json")

# name, character slug, book slug, sheet key in R2 (published cast)
CHARACTERS = [
    ("Juno", "juno", "motivationmanifesto", "characters/juno.png"),
    ("Pell", "pell", "motivationmanifesto", "characters/pell.png"),
    ("Tempo", "tempo", "motivationmanifesto", "characters/tempo.png"),
    ("Mira", "mira", "mastery", "characters/mira.png"),
    ("Ansel", "ansel", "mastery", "characters/ansel.png"),
    ("Dell", "dell", "mastery", "characters/dell.png"),
    ("The Otter", "the-otter", "mastery", "characters/the-otter.png"),
    ("Wren", "wren", "thewarofart", "characters/wren.png"),
    ("Cato", "cato", "thewarofart", "characters/cato.png"),
    ("the Fog", "the-fog", "thewarofart", "characters/fog.png"),
    ("Maisie", "maisie", "compoundeffect", "characters/maisie.png"),
    ("Jasper", "jasper", "compoundeffect", "characters/jasper.png"),
    ("Willa", "willa", "compoundeffect", "characters/willa.png"),
    ("Penny", "penny", "richdadpoordad", "characters/penny.png"),
    ("Bram", "bram", "richdadpoordad", "characters/bram.png"),
    ("Ruby", "ruby", "ruby-the-cheetah", "characters/ruby.png"),
    ("Tari", "tari", "ruby-the-cheetah", "characters/tari.png"),
    ("Quilla", "quilla", "ruby-the-cheetah", "characters/quilla.png"),
    ("Hazel", "hazel", "richdadpoordad", "characters/hazel.png"),
    ("Fern", "fern", "algorithms", "characters/fern.png"),
    ("Moss", "moss", "algorithms", "characters/moss.png"),
    ("Orin", "orin", "algorithms", "characters/orin.png"),
    ("Basil", "basil", "designpatterns", "characters/basil.png"),
    ("Ada", "ada", "designpatterns", "characters/ada.png"),
    ("Nox", "nox", "designpatterns", "characters/nox.png"),
    ("Wally", "wally", "docker", "characters/wally-v2.png"),
    ("Pip", "pip", "docker", "characters/pip-v2.png"),
    ("Skipper", "skipper", "docker", "characters/skipper-v2.png"),
    ("Tilda", "tilda", "iwillteach", "characters/tilda.png"),
    ("Bix", "bix", "iwillteach", "characters/bix.png"),
    ("Rook", "rook", "iwillteach", "characters/rook.png"),
]

# Sheets that live as local files instead of (or preferred over) the R2
# registry copy. Bix: CG's uploaded color sheet is the canonical art.
LOCAL_SHEETS = {
    "bix": os.path.expanduser(
        "~/workspace/user/media_library/image/bix-sheet-color.png"),
}

MIN_AREA = 6500          # mask pixels; filters captions ("Fox") and specks
DIST_THRESHOLD = 26      # color distance from local background estimate


def fetch(url: str) -> bytes:
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def r2_put(key: str, data: bytes) -> None:
    url = (f"https://api.cloudflare.com/client/v4/accounts/{ACCT}"
           f"/r2/buckets/{BUCKET}/objects/{urllib.parse.quote(key, safe='')}")
    req = urllib.request.Request(url, data=data, method="PUT",
                                 headers={"Content-Type": "image/png", "User-Agent": "curl/8.0"})
    dynamic_credentials.add_surrogate_to_request(
        req, "custom.cloudflare", entry_name="access_token",
        allowed_hosts=["api.cloudflare.com"])
    with urllib.request.urlopen(req, timeout=120) as r:
        body = json.loads(r.read().decode())
    if not body.get("success"):
        raise RuntimeError(f"R2 PUT {key} failed: {body}")


def pose_mask(img: Image.Image) -> np.ndarray:
    """Foreground mask via local background estimate (slow resize blur)."""
    arr = np.asarray(img.convert("RGB")).astype(np.int32)
    small = img.convert("RGB").resize((28, 38), Image.BILINEAR).resize(img.size, Image.BILINEAR)
    bg = np.asarray(small).astype(np.int32)
    dist = np.abs(arr - bg).max(axis=2)
    mask = dist > DIST_THRESHOLD
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3)), iterations=1)
    mask = ndimage.binary_opening(mask, structure=np.ones((2, 2)), iterations=1)
    return mask


def erode_split(sub: np.ndarray):
    """Split a merged cluster: erode until the thin wash/shadow bridges
    between poses break, then grow the surviving cores back over the
    cluster's pixels by nearest-seed assignment. A level counts only
    when EVERY grown piece is pose-sized, which is what keeps single
    wide poses (a magpie's spread wings, a fox's head) from being torn
    into fragments: their detached cores grow back too small. Returns a
    label image (0 = outside cluster) or None for one solid pose."""
    for it in (3, 5, 7):
        eroded = ndimage.binary_erosion(sub, structure=np.ones((3, 3)),
                                        iterations=it, border_value=0)
        lab, n = ndimage.label(eroded, structure=np.ones((3, 3)))
        if n < 2:
            continue
        sizes = ndimage.sum(eroded, lab, range(1, n + 1))
        keep = [i + 1 for i, s in enumerate(sizes) if s >= 2200]
        if len(keep) < 2:
            continue
        seeds = np.where(np.isin(lab, keep), lab, 0)
        _, inds = ndimage.distance_transform_edt(
            seeds == 0, return_distances=True, return_indices=True)
        grown = seeds[tuple(inds)]
        grown = np.where(sub, grown, 0)
        areas = ndimage.sum(sub, grown, keep)
        if all(a >= MIN_AREA for a in areas):
            return grown
    return None


def detect_boxes(img: Image.Image) -> list:
    mask = pose_mask(img)
    # Dilation bridges hairline gaps inside one pose (thin legs, wisps).
    # Poses sit much farther apart than this, and fragments are joined at
    # the pixel level only: bounding boxes of diagonal neighbours overlap
    # in these loose grids, so box-level merging would fuse distinct poses.
    dil = ndimage.binary_dilation(mask, structure=np.ones((3, 3)), iterations=3)
    lab, n = ndimage.label(dil, structure=np.ones((3, 3)))
    clusters = []  # (label id, raw-mask area)
    for i in range(1, n + 1):
        area = int(mask[lab == i].sum())
        if area >= MIN_AREA:
            clusters.append((i, area))
    if not clusters:
        return []
    areas = sorted(a for _, a in clusters)
    median_area = areas[len(areas) // 2]
    # Pixel sets per final pose, as boolean masks over the full image.
    pose_masks = []
    for cid, area in clusters:
        sub = (lab == cid) & mask
        suspicious = area > 1.45 * median_area or (len(clusters) <= 2 and area > 100_000)
        grown = erode_split(sub) if suspicious else None
        if grown is not None:
            for piece in sorted(set(grown[grown > 0].tolist())):
                pose_masks.append(grown == piece)
        else:
            pose_masks.append(sub)
    boxes = []
    for pm in pose_masks:
        if pm.sum() < MIN_AREA:
            continue
        ys, xs = np.where(pm)
        boxes.append([int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1])
    # reading order: group into rows by top edge (tolerance scaled to the
    # median pose height), then left-to-right inside each row
    heights = sorted(b[3] - b[1] for b in boxes)
    tol = 0.38 * heights[len(heights) // 2]
    boxes.sort(key=lambda b: b[1])
    rows = []
    for b in boxes:
        if rows and b[1] - min(r[1] for r in rows[-1]) <= tol:
            rows[-1].append(b)
        else:
            rows.append([b])
    ordered = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda b: b[0]))
    return ordered


def extract(img: Image.Image, boxes: list) -> list:
    W, H = img.size
    crops = []
    for (x0, y0, x1, y1) in boxes:
        pad = int(0.04 * max(x1 - x0, y1 - y0)) + 6
        cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
        cx1, cy1 = min(W, x1 + pad), min(H, y1 + pad)
        crops.append(img.crop((cx0, cy0, cx1, cy1)))
    return crops


# Hand-measured boxes for sheets whose poses chain together through
# near-touches and shared ground shadows that defeat the automatic
# splits (verified against the sheets by eye). [x0, y0, x1, y1] in
# sheet pixels, reading order.
MANUAL_BOXES = {
    # three standing squirrels share a shadow band + basket bridges;
    # the fourth is the seated pose
    "hazel": [[45, 475, 308, 820], [280, 445, 540, 820],
              [515, 375, 865, 815], [400, 815, 875, 1185]],
    # three head studies (auto-detected cleanly, kept), then back view,
    # front view and seated, which chain-merge along tail/satchel/shadow
    "bram": [[38, 58, 337, 360], [346, 53, 586, 299], [633, 53, 866, 294],
             [440, 285, 875, 840], [50, 485, 485, 1175], [350, 715, 875, 1175]],
    # four cranes interlock (necks over legs, staggered bodies): profile
    # back-left, front-left, middle, right
    "cato": [[15, 80, 395, 705], [200, 370, 470, 1155],
             [435, 300, 695, 1105], [610, 490, 880, 1155]],
    # the middle pair (head close-up, runner) is bridged by ground wash
    # and splash dots into one mask cluster: standing, close-up,
    # runner, swimming, on a rock.
    # RE-MEASURED 2026-10-28 (cast gallery editor pass): these tight
    # boxes are the exact inverse of the shipped gallery boxes under
    # extract()'s padding, so a re-run reproduces the live crops pixel
    # for pixel. The shipped boxes were measured off the sheet so each
    # crop holds its full subject and no neighbour: standing incl.
    # whiskers, close-up stopped 5px short of the runner's tail tip,
    # swimming stopped above the rock pose's tail. Known limit: the
    # rock pose's rectangle unavoidably frames the swimming pose's
    # tail tip in its empty top-left (the two tails interleave in
    # projection); flagged for CG rather than hidden.
    "the-otter": [[97, 81, 781, 389], [95, 441, 309, 735],
                  [355, 497, 833, 751], [62, 780, 486, 1040],
                  [421, 881, 851, 1137]],
    # Ruby the Cheetah cast (added 2026-11-10): the rich hero sheets pack
    # their turnaround rows too tightly for contour detection (figures
    # merge into pair clusters), so the gallery boxes are hand-measured
    # off the sheets. Curated to full-body poses + one head study each,
    # matching the rest of the cast; object studies are not gallery poses.
    # Ruby: front, side, back, walking, carving at the waystone, head.
    "ruby": [[30, 59, 215, 387], [215, 58, 498, 387], [694, 58, 848, 387],
             [1, 446, 356, 732], [329, 488, 612, 760], [38, 797, 236, 985]],
    # Quilla: front, side, back (green backpack), walking with the rolled
    # map, crouched over the spread map, head.
    "quilla": [[53, 60, 243, 353], [243, 59, 465, 353], [469, 59, 680, 351],
               [54, 375, 259, 661], [319, 396, 621, 666], [42, 702, 225, 912]],
    # Tari: front, walking, counting seed pods, sitting, head. The
    # turnaround row interleaves (the side view's head pokes into the
    # back view's rectangle and vice versa), so the side/back/three-
    # quarter views stay sheet-only rather than shipping neighbour
    # intrusions in the gallery crops.
    "tari": [[45, 80, 245, 335], [26, 374, 333, 673], [342, 427, 617, 673],
             [629, 410, 870, 675], [49, 733, 225, 947]],
}


def process(name, slug, book, img, local_only, published, sheet_ref, manifest, report):
    if slug in MANUAL_BOXES:
        boxes = MANUAL_BOXES[slug]
        method = "manual"
    else:
        boxes = detect_boxes(img)
        method = "contour"
    if len(boxes) < 2:
        method = "sheet-fallback"
        boxes = [[0, 0, img.size[0], img.size[1]]]
    crops = extract(img, boxes)
    cdir = os.path.join(OUT_DIR, slug)
    os.makedirs(cdir, exist_ok=True)
    urls = []
    for i, crop in enumerate(crops):
        buf = io.BytesIO()
        crop.save(buf, "PNG")
        data = buf.getvalue()
        pose_key = f"cast-gallery/{slug}/pose-{i + 1}.png"
        with open(os.path.join(cdir, f"pose-{i + 1}.png"), "wb") as f:
            f.write(data)
        if i == 0:
            with open(os.path.join(cdir, "portrait.png"), "wb") as f:
                f.write(data)
            if not local_only:
                r2_put(f"cast-gallery/{slug}/portrait.png", data)
        if not local_only:
            r2_put(pose_key, data)
        urls.append(f"{R2_PUBLIC}/{pose_key}")
    manifest["characters"][slug] = {
        "name": name,
        "bookSlug": book,
        "sheetKey": sheet_ref,
        "portrait": f"{R2_PUBLIC}/cast-gallery/{slug}/portrait.png",
        "poses": urls,
        "poseCount": len(urls),
        "method": method,
        "published": published,
    }
    report.append(f"{slug}: {len(urls)} poses ({method}) boxes={boxes}")
    print(report[-1], flush=True)


def main() -> None:
    local_only = "--local-only" in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {"generatedAt": int(time.time()), "characters": {}}
    report = []
    for name, slug, book, key in CHARACTERS:
        if slug in LOCAL_SHEETS:
            img = Image.open(LOCAL_SHEETS[slug]).convert("RGB")
            process(name, slug, book, img, local_only, True,
                    "local:" + os.path.basename(LOCAL_SHEETS[slug]),
                    manifest, report)
            continue
        raw = fetch(f"{R2_PUBLIC}/{key}")
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        process(name, slug, book, img, local_only, True, key, manifest, report)
    with open(os.path.abspath(MANIFEST), "w") as f:
        json.dump(manifest, f, indent=1)
    print("\n".join(report))
    print("manifest:", os.path.abspath(MANIFEST))


if __name__ == "__main__":
    main()
