# Image derivatives + media host

Why: the zone is on Cloudflare Free. Polish / Mirage / Image
Resizing are plan-gated, so right-sized images are produced locally
and the caching/protection lives in code + R2 object metadata
instead. (Full history: the VM copy of this README under
~/workspace/factory-ops/image-derivatives/.)

Pieces:

- gen_derivatives.py (VM tooling folder): downloads the cast gallery
  + book covers from R2, writes WebP derivatives (portrait w560 card
  / w880 hero, poses w640, covers w400 card at q60 / w960 hero), and
  emits image-derivatives.json. Cover entries carry sourceBytes and
  cardBytes: the hub versions derivative URLs by byte size, so a
  regenerated derivative gets a new URL and busts the media host's
  immutable cache. The hub keeps a baked copy at
  src/data/image-derivatives.json and a mirror in R2.
- media-worker.mjs (THIS folder is the canonical source as of
  2026-11-03): the permanent bbs-media worker on
  media.bigbrainshelf.com. It serves only cast-gallery art + book
  covers (incl. derivatives) and swaps in the deterrent card for
  foreign referers. Cache policy: derivative keys (-w<width>.webp)
  are immutable for a year (safe: their URLs are byte-versioned);
  originals (cover-titled.jpg, portrait.png, pose files) get
  max-age=300, because their URLs are stable across replacements and
  an immutable original pins retired art for a year. Deploy: copy to
  the VM tooling folder and run deploy_media.py there. The VM copy is
  a staging copy, not the source of truth.
- audit_derivatives.py (this folder): the anti-stranding guard.
  Compares the baked map against live R2 cover bytes for every book
  in D1 with a titled cover and fails loud (exit 1, named problems)
  on any drift: a cover replaced without a derivative refresh, a
  derivative whose live size disagrees with the map, or a titled
  book with no map entry at all. It reads R2/D1 through the runner
  credential helper, so it runs where the factory-ops tools run,
  not in hub CI.

The flow after ANY cover or gallery art change:

1. Replace the art in R2.
2. Rerun gen_derivatives.py; refresh the baked map in
   src/data/image-derivatives.json and the R2 mirror.
3. Run audit_derivatives.py. It must pass before the hub redeploy.
4. Redeploy the hub.
5. Only if media-worker.mjs changed: refresh the VM staging copy
   from this folder and redeploy bbs-media with deploy_media.py.

Step 3 is the step whose absence stranded the renamed books'
covers in November 2026: the covers were replaced, step 2 was
skipped, and every surface disagreed until CG spotted the old
names by eye.
