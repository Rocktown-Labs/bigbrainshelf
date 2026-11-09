# Factory tuning bench, 2026-11-09

Books measured: `iwillteach` (Tilda), line edition, all 40 installed
pages; control: `mira-the-heron-and-the-still-water`, line edition, 12
installed pages. Run date: 2026-11-09.

Replay of the new tuning-gate propositions (exact phrasings from
factory/src/ai.ts after the tuning change) over Tilda's 40 installed line pages
(labeled by census v2 + CG's viewer verdicts) and 12 Mira line pages as
the clean control set. Clef via the Workers AI REST endpoint; harness in
RGM's factory-ops/tmp (bench_tuning.py), raw scores in
bench_tuning_results.json.

## Verdicts per gate

- **outline_only, bar 0.5: SHIPS.** Filled pages score 0.029-0.227
  (S1 finale, S2p1, S1p2, S4p3, S6p0, S6 finale, S5 finale); every clean
  Tilda page scores 0.878-0.964 and all 12 Mira pages 0.921-0.958. Zero
  false flags, full recall on the measured fills.
- **style_match, bar lowered 0.5 to 0.35.** True chibi finales score
  0.106 (S4) and 0.145 (S2); verified-clean pages are noisy in the
  0.39-0.56 band (a shipped Mira page replays at 0.392, two more under
  0.52). At 0.5 the gate burns paid re-rolls on clean pages; at 0.35 it
  catches the egregious breaks, misses the mildest drift (S5 finale
  0.434, S8 finale 0.45), and stays appealable. Precision over recall,
  per the spend discipline.
- **no_humans (strengthened wording), bar 0.5: SHIPS.** The confirmed
  cases score 0.022 (S2p0 fair silhouettes) and 0.279 (S2p1 villagers);
  the three census suspects (S3p0, S4p0, S8p2) score 0.299-0.354 and
  S1p2 scores 0.444 (tiny village figures under the nest). All 12 Mira
  pages score 0.934-0.966.
- **no_extra_characters, bar 0.5: SHIPS with a note.** The confirmed
  clone page (S2p0, three magpies) scores 0.305, and the flags agree
  with the census extra-magpie suspects (S2p3, S3p0, S3 finale, S6p1,
  S6p3). The bench asked with the full book cast; production asks with
  the per-page cast, which is the stricter and correct form. The Mira
  rows for this question are meaningless (bench artifact: Tilda's cast
  names were put to Mira pages) and are recorded for completeness only.
  The gate is appealable and the edit pass steers on it.
- **wardrobe_complete, bar 0.5: SHIPS as a floor.** Fully dressed Bix
  pages score 0.587-0.795; the worst outfit failure (S1p2, nest page)
  scores 0.384 and is caught. Single-proposition wardrobe judgment
  gives partial credit, so two known pants-missing pages score above
  the bar (S1p1 0.626, S5 finale 0.595) and no higher bar separates
  cleanly (0.65 false-flags two dressed pages). The gate catches
  egregious cases; the known pages ride the rerun list by name.
