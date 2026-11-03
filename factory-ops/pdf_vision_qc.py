#!/usr/bin/env python3
"""Measure a book's DELIVERED PDFs the way a person flipping
through them would (CG, 2026-10-31): render every page, then
judge it.

Two instruments, because each is exact where the other is not:
  - Pixel saturation (PIL): a page either carries real color or
    it does not. Decisive for line purity.
  - Clef (the factory's vision judge, via cast_audit.clef_judge):
    the semantic checks: color or gray fills in the art (the
    factory's own has_color proposition), whether the coloring
    pages' bottom captions are whole, whether the front cover
    is the finished titled cover, whether the back cover's text
    is complete.

Writes the aggregate into D1 book_qa (the hub's readiness
checklist reads it): cover_typeset, coloring_captions_truncated,
back_cover_truncated, line_purity (1 pure / 0 colored found),
source, measured_at. A per-page report lands in
factory-ops/pdf-qc-reports/{slug}.json.

Usage: python3 pdf_vision_qc.py <internal-slug> [...]
"""
import sys, os, json, subprocess, tempfile, time
sys.path.insert(0, "/home/hatch/workspace/kidsbook-video/runner")
sys.path.insert(0, "/home/hatch/workspace/factory-ops")
import cover  # r2_get
from cast_audit import clef_judge
from PIL import Image

CF = "/home/hatch/workspace/factory-ops/cf.py"
REPORTS = "/home/hatch/workspace/factory-ops/pdf-qc-reports"
BAR = 0.5

def d1(sql):
    out = subprocess.run(["python3", CF, sql], capture_output=True, text=True, timeout=120)
    return json.loads(out.stdout)

def sql_exec(sql):
    d1(sql)

def render(pdf_bytes, tag, workdir):
    path = os.path.join(workdir, f"{tag}.pdf")
    open(path, "wb").write(pdf_bytes)
    subprocess.run(["pdftoppm", "-png", "-r", "60", path, os.path.join(workdir, tag)],
                   check=True, capture_output=True, timeout=600)
    pages = sorted(f for f in os.listdir(workdir) if f.startswith(tag + "-") and f.endswith(".png"))
    return [os.path.join(workdir, p) for p in pages]

def color_fraction(png_path):
    """Fraction of pixels carrying real saturation."""
    im = Image.open(png_path).convert("RGB")
    im.thumbnail((340, 440))
    hsv = im.convert("HSV")
    s = hsv.getchannel("S")
    hist = s.histogram()
    total = sum(hist)
    colored = sum(hist[70:])
    return colored / total if total else 0.0

Q_COLOR = {"type": "noul", "instructions": "Does this image contain any color, shading, or gray fills (anything other than pure black lines on white)?"}
Q_CAPTION = {"type": "noul", "instructions": "This is a coloring book page with story text printed at the bottom. Is ALL of the text at the bottom fully visible and complete, with no words or lines cut off, missing, or running off the edge of the page?"}
Q_COVER_TITLE = {"type": "noul", "instructions": "Does this image show a finished book cover with the book's title written on it in large letters?"}
Q_BACK = {"type": "noul", "instructions": "This is the back cover of a children's book. Is ALL of the text on it fully visible and complete, with no lines cut off at the edges or running off the page?"}

def judge(png_path, questions):
    with open(png_path, "rb") as f:
        return clef_judge(f.read(), questions)

MATTER_MARKERS = ("contents", "words to know", "all rights reserved", "meet the cast", "about this book")

def page_text(pdf_path, page_no):
    out = subprocess.run(["pdftotext", "-f", str(page_no), "-l", str(page_no), pdf_path, "-"],
                         capture_output=True, text=True, timeout=60)
    return out.stdout or ""

def is_matter(text):
    head = " ".join(text.lower().split()[:40])
    return any(m in head for m in MATTER_MARKERS)

def measure_pdf(pdf_bytes, tag, workdir, is_coloring):
    pages = render(pdf_bytes, tag, workdir)
    pdf_path = os.path.join(workdir, f"{tag}.pdf")
    n = len(pages)
    out = {"pages": n, "colored_pages": [], "colored_matter_pages": [], "caption_truncated_pages": [],
           "cover": None, "back": None, "detail": []}
    for i, p in enumerate(pages):
        page_no = i + 1
        frac = color_fraction(p)
        rec = {"page": page_no, "color_fraction": round(frac, 5)}
        if page_no == 1:
            s = judge(p, {"cover_title": Q_COVER_TITLE})
            rec["clef"] = s
            out["cover"] = {"has_title": (s.get("cover_title") or 0) >= BAR, "scores": s}
        elif page_no == n:
            s = judge(p, {"back_complete": Q_BACK})
            rec["clef"] = s
            out["back"] = {"complete": (s.get("back_complete") or 0) >= BAR, "scores": s}
        else:
            # Line purity judges STORY pages. The book's furniture
            # (contents, copyright, words to know, cast pages) is
            # designed matter and may carry color on purpose; its
            # color is reported, never counted as a purity failure.
            matter = is_matter(page_text(pdf_path, page_no))
            rec["matter"] = matter
            qs = {"has_color": Q_COLOR}
            if is_coloring and not matter:
                qs["caption_complete"] = Q_CAPTION
            s = judge(p, qs)
            rec["clef"] = s
            clef_color = (s.get("has_color") or 0) >= BAR
            pixel_color = frac >= 0.005
            if clef_color or pixel_color:
                rec["colored_by"] = ("clef " if clef_color else "") + ("pixel" if pixel_color else "")
                (out["colored_matter_pages"] if matter else out["colored_pages"]).append(page_no)
            if is_coloring and not matter and (s.get("caption_complete") or 0) < BAR:
                out["caption_truncated_pages"].append(page_no)
        out["detail"].append(rec)
    return out

def main():
    os.makedirs(REPORTS, exist_ok=True)
    for slug in sys.argv[1:]:
        rows = d1(f"SELECT picture_book_key, coloring_book_key, title FROM books WHERE slug='{slug}'")["result"][0]["results"]
        book = rows[0]
        print(f"== {slug}: {book['title']}")
        with tempfile.TemporaryDirectory() as wd:
            pic = measure_pdf(cover.r2_get(book["picture_book_key"]), "pic", wd, is_coloring=False)
            col = measure_pdf(cover.r2_get(book["coloring_book_key"]), "col", wd, is_coloring=True)
        colored = sorted(set(pic["colored_pages"]) | set(col["colored_pages"]))
        line_purity = 0 if colored else 1
        captions_truncated = len(col["caption_truncated_pages"])
        cover_typeset = 0 if (pic["cover"] and pic["cover"]["has_title"]) else 1
        back_truncated = 0 if all(x["back"] and x["back"]["complete"] for x in (pic, col)) else 1
        report = {"slug": slug, "title": book["title"], "measured_at": int(time.time()),
                  "picture_book": pic, "coloring_book": col,
                  "aggregate": {"line_purity": line_purity, "colored_pages_picture": pic["colored_pages"],
                                "colored_pages_coloring": col["colored_pages"],
                                "colored_matter_pages_picture": pic["colored_matter_pages"],
                                "colored_matter_pages_coloring": col["colored_matter_pages"],
                                "coloring_captions_truncated": captions_truncated,
                                "cover_typeset": cover_typeset, "back_cover_truncated": back_truncated}}
        with open(os.path.join(REPORTS, f"{slug}.json"), "w") as f:
            json.dump(report, f, indent=1)
        try:
            sql_exec("ALTER TABLE book_qa ADD COLUMN line_purity INTEGER")
        except Exception:
            pass
        now = int(time.time())
        sql_exec(
            "INSERT INTO book_qa (slug, cover_typeset, coloring_captions_truncated, back_cover_truncated, line_purity, source, measured_at) "
            f"VALUES ('{slug}', {cover_typeset}, {captions_truncated}, {back_truncated}, {line_purity}, 'vision QC pilot (Clef + pixel, pdf_vision_qc.py)', {now}) "
            "ON CONFLICT(slug) DO UPDATE SET cover_typeset=excluded.cover_typeset, "
            "coloring_captions_truncated=excluded.coloring_captions_truncated, "
            "back_cover_truncated=excluded.back_cover_truncated, line_purity=excluded.line_purity, "
            "source=excluded.source, measured_at=excluded.measured_at")
        print(json.dumps(report["aggregate"], indent=1))

if __name__ == "__main__":
    main()
