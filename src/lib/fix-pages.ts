// Defect-listed pages that must never appear in the free samples.
// Generated from ~/workspace/factory-ops/fix-pages.json (the factory's
// verified fix list, 2026-10-27). Keys are book slugs; entries use the
// factory notation "S{chapter}p{page}" (page is 0-based) and
// "S{chapter} finale". Regenerate if the fix list changes; the sample
// builder in src/lib/sample.ts is the only consumer.

export const FIX_LINE_PAGES: Record<string, string[]> = {
  "algorithms": ["S2p1", "S2p2", "S2p3", "S2 finale", "S4p1", "S4p2", "S5p0", "S5p3", "S6p1", "S6p3", "S6 finale", "S8p1", "S8p2", "S9p1", "S9p2", "S10p0", "S10p1", "S10p2", "S10p3", "S10 finale", "S12 finale"],
  "compoundeffect": ["S1p1", "S1 finale", "S2p2", "S2 finale", "S3p1", "S3 finale", "S4p3", "S4 finale", "S5 finale", "S6p3", "S6 finale", "S7p2", "S7p3", "S7 finale", "S8p1", "S8p3"],
  "designpatterns": ["S2p2", "S3p2", "S8p0"],
  "docker": ["S1p3", "S2p0", "S3p0", "S3p1", "S7p0", "S7p1", "S7p3", "S8p1", "S11p1", "S11p3", "S13p2", "S13p3", "S15p2"],
  "mastery": ["S4p2", "S4p3", "S5p2"],
  "motivationmanifesto": ["S1p0", "S3p3", "S4p1", "S5p2", "S5 finale", "S6p0", "S7p1", "S7p2", "S7 finale", "S9p0", "S9p1", "S9p2", "S9 finale"],
  "richdadpoordad": ["S2p2", "S2p3", "S3p1", "S3p3", "S6p1", "S8p1"],
  "thewarofart": ["S1p2", "S2p2", "S5p1", "S5p3", "S6p1", "S7p0", "S7p1", "S7p3", "S8p1", "S8p2", "S8p3", "S8 finale"],
};

export const FIX_COLOR_PAGES: Record<string, string[]> = {
  "algorithms": ["S2p1", "S2p3", "S2 finale", "S6p1", "S6p3", "S6 finale", "S7p2", "S8p2", "S9p1", "S9p2", "S10p1", "S10p2", "S10p3", "S10p5", "S10 finale", "S11p2"],
};
