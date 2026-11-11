import { test, expect } from 'bun:test';
import {
  isAppealable,
  isGhostFlagged,
  pickAppealCandidate,
  APPEAL_GHOST_GATE_REASON,
} from '../factory/src/appeals';

// Ghost-limb gate (2026-11-11): a roll the Gemini ghost judge
// affirmatively flagged (scores.anatomy_ghost = 1) must never be
// rescued or installed through any appeal path. Judge-cleared rolls
// (0) and no-opinion rolls (no anatomy_ghost score; Clef fallback
// decided) keep the pre-gate appeal behavior.

const GHOST_REASON =
  'anatomy QC (ghost-limb judge google/gemini-2.5-flash): Rook has a third limb holding the watering can';

function reject(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    image_key: 'books/x/attempts/line/S1-p0-a1.jpg',
    outcome: 'qc_reject',
    reason: GHOST_REASON,
    scores: null,
    ...overrides,
  };
}

test('isGhostFlagged reads the verdict from object and stored-JSON scores', () => {
  expect(isGhostFlagged(reject({ scores: { anatomy_ghost: 1 } }))).toBe(true);
  expect(isGhostFlagged(reject({ scores: '{"anatomy_ghost":1}' }))).toBe(true);
  expect(isGhostFlagged(reject({ scores: { anatomy_ghost: 0 } }))).toBe(false);
  expect(isGhostFlagged(reject({ scores: '{"anatomy_ghost":0,"anatomy":0.9}' }))).toBe(false);
});

test('isGhostFlagged treats absent or unparseable scores as no-opinion, not a flag', () => {
  expect(isGhostFlagged(reject({ scores: null }))).toBe(false);
  expect(isGhostFlagged(reject({ scores: { anatomy: 0.12 } }))).toBe(false);
  expect(isGhostFlagged(reject({ scores: 'not json' }))).toBe(false);
  expect(isGhostFlagged(null)).toBe(false);
  expect(isGhostFlagged(undefined)).toBe(false);
});

test('the ghost rejection reason alone is appealable, so the score gate is what blocks it', () => {
  expect(isAppealable(GHOST_REASON)).toBe(true);
  expect(APPEAL_GHOST_GATE_REASON).toContain('anatomy_ghost=1');
});

test('pickAppealCandidate never selects a ghost-flagged roll', () => {
  const ghost = reject({ id: 7, scores: { anatomy_ghost: 1 } });
  expect(pickAppealCandidate([ghost])).toBeNull();

  const cleared = reject({ id: 5, scores: { anatomy_ghost: 0 } });
  // The most recent reject is the ghost; the earlier judge-cleared
  // reject is the candidate instead.
  expect(pickAppealCandidate([cleared, ghost])?.id).toBe(5);
});

test('pickAppealCandidate preserves behavior for cleared and no-opinion rolls', () => {
  const noOpinion = reject({ id: 3, reason: 'anatomy QC (line): score=0.21 below 0.3', scores: { anatomy: 0.21 } });
  const cleared = reject({ id: 4, scores: '{"anatomy_ghost":0}' });
  expect(pickAppealCandidate([noOpinion])?.id).toBe(3);
  expect(pickAppealCandidate([noOpinion, cleared])?.id).toBe(4);
});

test('pickAppealCandidate still excludes reliable-gate and imageless rejects', () => {
  const textReject = reject({ id: 8, reason: 'line QC: has_text=0.900 (bar 0.12)', scores: { anatomy_ghost: 0 } });
  const noImage = reject({ id: 9, image_key: null, scores: { anatomy_ghost: 0 } });
  expect(pickAppealCandidate([textReject, noImage])).toBeNull();
});
