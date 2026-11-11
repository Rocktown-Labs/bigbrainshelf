// ------------------------------------------------------- appeals queue
//
// Production QC (Clef) rejects a roll on a noisy judgment gate. The
// appeal re-judges the archived roll with an independent model and
// logs the verdict to D1 qc_second_opinions, shadow mode: it never
// accepts, ships, or changes anything. Its job is measurement (how
// often was the gate wrong, on which gates, what would rescue have
// saved) feeding the judge bake-off. Merged factory-scale plan, step
// 7: Queues for appeals with idempotency and a dead-letter queue.
//
// Producer: POST /book/{slug}/appeals/enqueue scans gen_attempts for
// appealable rejects (same rule as factory-ops/second_opinion.py:
// noisy-gate reasons only, reliable gates are never appealed) that
// have not been judged or queued, and sends one message per attempt.
// Consumer: this module's handleAppealsBatch, bound as the worker's
// queue handler. Idempotency key = (attempt_id, judge_model): a
// redelivered message whose verdict already exists is acked without
// re-judging. Judge errors retry; the queue's DLQ (factory-appeals-dlq)
// is the end of the line after max_retries.
//
// Judge today: Claude Opus 5.5 (anthropic/claude-opus-5.5) via the
// Vercel AI Gateway chat route. Seat history, from the judge shootouts
// (factory-ops/judge_shootout*.py, 7 human-verified pages): Clef-Omni
// held this seat first and was flat (gap +0.002, clears everything;
// CG removed it 2026-11-02). GPT-6 Luna failed through both the
// Decisions route (predicates pinned to a 0.03-0.15 floor) and chat.
// Round 2 was UNSTABLE across reruns: Qwen3-VL went 7/7 in one run
// and all-clear (4/7, gap -0.002) in the next, matching its saturated
// 0.00/1.00 production verdicts; Gemini 4 Argon flipped from 3/7 to
// 6/7; Qwen3.8-Max alternated flag-everything with empty replies.
// Opus was the only judge that flagged every broken page in all
// three runs (9/9); its errors are conservative false-flags on clean
// pages, the safe direction for an appeals seat. It holds the seat
// until a repeated-measures bench on human-labeled pages (3 runs per
// judge) settles the question properly. Shadow mode throughout:
// verdicts are logged, never acted on.
//
// Graduation (2026-11-07, CG's call after a night of gate-noise
// losses: Wren colorize parked 5 pages on dupe/anatomy scores the
// human eye cleared, Fenix repair landed 1 of 13): the generation
// loops now call attemptInlineAppeal at the hold point, the one
// place a verdict acts. When every roll has failed and the page
// would park, the most recent appealable reject is judged
// synchronously; a rescue_candidate verdict ships that archived
// roll (logged as outcome accepted_appeal) instead of holding.
// The queue path above stays shadow measurement; the inline path
// reuses the same judge, the same idempotency key, and the same
// qc_second_opinions record, so both lanes read as one history.
//
// Ghost-limb gate (2026-11-11): an attempt whose QC scores carry
// anatomy_ghost = 1 (the Gemini ghost judge's affirmative verdict,
// PR #94) is never appealable. The appeal rescued two judge-flagged
// Tilda rolls in the judge's first production run; see
// APPEAL_GHOST_GATE_REASON below for the exact semantics.

import { emitEvent } from "./events";
import { emitAppealMetric } from "./metrics";

const JUDGE_MODEL = "anthropic/claude-opus-5.5";
const JUDGE_PROVIDER = "vercel-gateway";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

const APPEALABLE_MARKERS = ["anatomy", "dupe", "cast integrity", "drift", "single_scene", "single scene", "outline_only", "wardrobe_complete", "no_extra_characters", "style_match"];
const RELIABLE_MARKERS = ["has_text", "has_color", "purity", "is_lineart", "text="];

export function isAppealable(reason: string | null | undefined): boolean {
  const r = (reason ?? "").toLowerCase();
  if (RELIABLE_MARKERS.some((m) => r.includes(m))) return false;
  return APPEALABLE_MARKERS.some((m) => r.includes(m));
}

// ------------------------------------------------- ghost-limb gate
//
// (2026-11-11, CG's ruling after the first production judge run.)
// The Gemini ghost-limb judge (PR #94) is the deciding anatomy gate;
// its affirmative verdict lands in an attempt's scores as
// anatomy_ghost = 1. "anatomy" is an appealable marker above, so the
// Opus appeal could second-guess a ghost rejection, and did: it
// rescued and shipped two Tilda rolls the judge had flagged (S1p3:
// phantom hand on the watering can; S3p0: phantom leg, plus a
// duplicated Rook). An affirmative ghost verdict is therefore NOT
// appealable: no appeal path (inline rescue, queue enqueue, or a
// verdict recorded earlier and reused by idempotency) may rescue or
// install such a roll. Rolls the judge cleared (anatomy_ghost = 0)
// and rolls it never saw (no anatomy_ghost score; the Clef fallback
// decided, the pre-judge archive) keep the existing appeal behavior.
// CG's own manual admin promotion of an archived roll is a human
// verdict, not an appeal, and is deliberately not gated here.
export const APPEAL_GHOST_GATE_REASON =
  "appeal blocked by ghost-limb gate: anatomy_ghost=1 (ghost-limb judge flagged this roll; affirmative ghost verdicts are not appealable)";

// True when the attempt's recorded QC scores carry an affirmative
// ghost-limb verdict. Scores arrive as an object (rows built in
// memory) or as the JSON string stored in gen_attempts.scores;
// anything unparseable or absent is no-opinion, not a flag.
export function isGhostFlagged(row: any): boolean {
  if (!row) return false;
  let scores: any = (row as any).scores;
  if (typeof scores === "string") {
    try {
      scores = JSON.parse(scores);
    } catch {
      return false;
    }
  }
  return scores != null && Number(scores.anatomy_ghost) === 1;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

let tablesReady = false;
async function ensureTables(env: any): Promise<void> {
  if (tablesReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS appeals_enqueued (attempt_id INTEGER PRIMARY KEY, slug TEXT, queued_at INTEGER)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS qc_second_opinions (attempt_id INTEGER, slug TEXT, kind TEXT, chapter TEXT, page INTEGER, attempt INTEGER, production_outcome TEXT, production_reason TEXT, production_scores TEXT, judge_provider TEXT, judge_model TEXT, verdict TEXT, claim_upheld INTEGER, confidence REAL, defects TEXT, rationale TEXT, judge_tokens_in INTEGER, judge_tokens_out INTEGER, human_verdict TEXT, created_at INTEGER)"
  ).run();
  tablesReady = true;
}

export async function enqueueAppeals(
  env: any,
  slug: string,
  limit = 25
): Promise<{ queued: number; candidates: number }> {
  await ensureTables(env);
  const rows: any = await env.DB.prepare(
    "SELECT id, kind, chapter, page, attempt, outcome, reason, scores, image_key FROM gen_attempts WHERE slug=? AND outcome NOT IN ('accepted','autofixed','promoted') ORDER BY id"
  )
    .bind(slug)
    .all();
  const judged: any = await env.DB.prepare(
    "SELECT DISTINCT attempt_id FROM qc_second_opinions WHERE slug=?"
  )
    .bind(slug)
    .all();
  const judgedIds = new Set((judged.results ?? []).map((r: any) => r.attempt_id));
  const queuedRows: any = await env.DB.prepare(
    "SELECT attempt_id FROM appeals_enqueued WHERE slug=?"
  )
    .bind(slug)
    .all();
  const queuedIds = new Set((queuedRows.results ?? []).map((r: any) => r.attempt_id));

  const cands = (rows.results ?? []).filter(
    (r: any) =>
      r.image_key &&
      isAppealable(r.reason) &&
      !isGhostFlagged(r) &&
      !judgedIds.has(r.id) &&
      !queuedIds.has(r.id)
  );
  let queued = 0;
  for (const r of cands.slice(0, limit)) {
    await env.APPEALS.send({ attemptId: r.id, slug });
    await env.DB.prepare("INSERT OR IGNORE INTO appeals_enqueued (attempt_id, slug, queued_at) VALUES (?,?,?)")
      .bind(r.id, slug, Math.floor(Date.now() / 1000))
      .run();
    queued++;
  }
  await emitEvent(env, {
    slug,
    kind: "appeal",
    event: "appeals_enqueued",
    detail: { queued, candidates: cands.length },
  });
  return { queued, candidates: cands.length };
}

const APPEAL_STATE =
  "You are an appeals judge for a children's picture book factory. A first QC system rejected the attached page illustration. " +
  "Judge ONLY what is actually drawn. Reflections and shadows of a character are part of that character, not a second character. " +
  "Two animals of the same species can be two different characters: look for distinguishing features before calling a duplicate. " +
  "Anatomy is defective only if a body part is clearly wrong (a hand or foot shape where a wing, fin, or animal foot belongs, extra or missing limbs). " +
  "Normal stylized animal anatomy in a children's book is NOT defective.";

async function judgeAttempt(env: any, attemptId: number): Promise<any> {
  const row: any = await env.DB.prepare("SELECT * FROM gen_attempts WHERE id=?")
    .bind(attemptId)
    .first();
  if (!row) throw new Error(`gen_attempt ${attemptId} not found`);
  if (!row.image_key) throw new Error(`gen_attempt ${attemptId} has no archived image`);
  const obj = await env.BOOKS.get(row.image_key);
  if (!obj) throw new Error(`archived image missing: ${row.image_key}`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;

  const key = env.AI_GATEWAY_KEY;
  if (!key) throw new Error("AI_GATEWAY_KEY secret not set");
  const claim = String(row.reason ?? "").slice(0, 300);
  const prompt =
    APPEAL_STATE +
    `\nThe first QC system rejected this page claiming: "${claim}". Answer three questions about the image as probabilities from 0 to 1: ` +
    "claim_defect = the claimed defect is truly present in this image; " +
    "serious_defect = the image has ANY defect that should block publication, including defects the claim did not name; " +
    "publishable = the page could be published as-is without a child or parent noticing anything wrong. " +
    'Return ONLY a JSON object: {"claim_defect": <p>, "serious_defect": <p>, "publishable": <p>}';
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${isPng ? "image/png" : "image/jpeg"};base64,${bytesToB64(bytes)}`,
              },
            },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`gateway HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const resp: any = await res.json();
  const text = String(resp?.choices?.[0]?.message?.content ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`judge reply unparseable: ${text.slice(0, 140)}`);
  const a = JSON.parse(text.slice(start, end + 1));
  const claimP = Number(a.claim_defect ?? 0);
  const seriousP = Number(a.serious_defect ?? 0);
  const pubP = Number(a.publishable ?? 0);
  if (![claimP, seriousP, pubP].every((n) => Number.isFinite(n))) {
    throw new Error(`judge reply carried non-numeric probabilities: ${text.slice(0, 140)}`);
  }
  const tokIn = resp?.usage?.prompt_tokens ?? null;
  const tokOut = resp?.usage?.completion_tokens ?? null;
  const claimUpheld = claimP >= 0.5;
  const verdict = claimUpheld
    ? "upheld"
    : seriousP >= 0.5
      ? "mixed_serious_other"
      : pubP >= 0.5
        ? "rescue_candidate"
        : "mixed_unclear";
  const confidence = Math.round((claimUpheld ? claimP : 1 - claimP) * 1000) / 1000;
  return { row, verdict, claimUpheld, confidence, claimP, seriousP, pubP, tokIn, tokOut, bytes };
}

// Persist one judged opinion, shared by the queue consumer and the
// inline path so both lanes write the identical record.
async function recordOpinion(env: any, j: any, attemptId: number, slug: string): Promise<void> {
  const rationale =
    `Opus appeal: claim_defect=${j.claimP.toFixed(2)}, serious_defect=${j.seriousP.toFixed(2)}, ` +
    `publishable=${j.pubP.toFixed(2)} against production claim "${String(j.row.reason ?? "").slice(0, 160)}"`;
  await env.DB.prepare(
    "INSERT INTO qc_second_opinions (attempt_id, slug, kind, chapter, page, attempt, production_outcome, production_reason, production_scores, judge_provider, judge_model, verdict, claim_upheld, confidence, defects, rationale, judge_tokens_in, judge_tokens_out, human_verdict, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  )
    .bind(
      attemptId,
      j.row.slug,
      j.row.kind,
      j.row.chapter,
      j.row.page,
      j.row.attempt,
      j.row.outcome,
      j.row.reason,
      j.row.scores,
      JUDGE_PROVIDER,
      JUDGE_MODEL,
      j.verdict,
      j.claimUpheld ? 1 : 0,
      j.confidence,
      JSON.stringify(j.verdict === "rescue_candidate" ? [] : ["see rationale probabilities"]),
      rationale,
      j.tokIn,
      j.tokOut,
      null,
      Math.floor(Date.now() / 1000)
    )
    .run();
  emitAppealMetric(env, slug ?? j.row.slug, JUDGE_MODEL, j.verdict, j.claimUpheld ? 1 : 0);
  await emitEvent(env, {
    slug: slug ?? j.row.slug,
    kind: "appeal",
    event: "appeal_judged",
    detail: { attemptId, verdict: j.verdict, claimUpheld: j.claimUpheld, confidence: j.confidence },
  });
}

// The appealable candidate among one page's attempts from a single
// generation run: the most recent archived reject on a noisy gate.
// Later attempts are steered by the earlier QC findings, so the last
// reject is normally the closest miss; reliable-gate rejects
// (isAppealable false) are never candidates, and neither are rolls
// the ghost-limb judge affirmatively flagged (isGhostFlagged).
export function pickAppealCandidate(rows: any[]): any | null {
  const candidates = (rows ?? []).filter(
    (r) =>
      r &&
      r.image_key &&
      (r.outcome === "qc_reject" || r.outcome === "edit_reject" || r.outcome === "cast_reject") &&
      isAppealable(r.reason) &&
      !isGhostFlagged(r)
  );
  return candidates.length ? candidates[candidates.length - 1] : null;
}

export interface InlineAppealResult {
  rescued: boolean;
  bytes?: Uint8Array;
  verdict?: string;
  attemptId?: number;
}

// Synchronous second opinion at a generation hold point. Finds the
// page's appealable candidate among attempts logged since `sinceTs`
// (the caller's run start), judges it unless an opinion already
// exists for the (attempt, judge) idempotency key, and reports
// rescued only on a rescue_candidate verdict, returning the archived
// bytes so the caller can ship them. Never throws: any failure is a
// plain hold, exactly the pre-inline behavior.
export async function attemptInlineAppeal(
  env: any,
  slug: string,
  kind: string,
  chapter: string | null,
  page: number | null,
  sinceTs: number
): Promise<InlineAppealResult> {
  try {
    await ensureTables(env);
    const res: any = await env.DB.prepare(
      "SELECT id, reason, outcome, scores, image_key FROM gen_attempts WHERE slug=? AND kind=? AND chapter IS ? AND page IS ? AND created_at>=? ORDER BY id ASC"
    )
      .bind(slug, kind, chapter, page, sinceTs)
      .all();
    const runRows: any[] = res?.results ?? [];
    const cand = pickAppealCandidate(runRows);
    if (!cand) {
      // Archive the gate's refusals: rejects on this page that were
      // appealable on their reason alone and were excluded ONLY by
      // the ghost-limb gate. The hold itself is unchanged.
      const ghostBlocked = runRows.filter(
        (r) =>
          r &&
          r.image_key &&
          (r.outcome === "qc_reject" || r.outcome === "edit_reject" || r.outcome === "cast_reject") &&
          isAppealable(r.reason) &&
          isGhostFlagged(r)
      );
      if (ghostBlocked.length) {
        console.log(`inline appeal for ${slug} ${chapter ?? "?"}p${page ?? "?"}: ${APPEAL_GHOST_GATE_REASON} (attempts ${ghostBlocked.map((r) => r.id).join(", ")})`);
        await emitEvent(env, {
          slug,
          kind: "appeal",
          event: "appeal_blocked_ghost_gate",
          detail: {
            reason: APPEAL_GHOST_GATE_REASON,
            blockedAttemptIds: ghostBlocked.map((r) => r.id),
            chapter,
            page,
            kind,
          },
        });
      }
      return { rescued: false };
    }
    const seen: any = await env.DB.prepare(
      "SELECT verdict FROM qc_second_opinions WHERE attempt_id=? AND judge_model=?"
    )
      .bind(cand.id, JUDGE_MODEL)
      .first();
    let verdict: string | undefined = seen?.verdict ?? undefined;
    let bytes: Uint8Array | undefined;
    if (!verdict) {
      const j = await judgeAttempt(env, cand.id);
      verdict = j.verdict;
      bytes = j.bytes;
      await recordOpinion(env, j, cand.id, slug);
    }
    if (verdict !== "rescue_candidate") {
      return { rescued: false, verdict, attemptId: cand.id };
    }
    // Final guard, defense in depth behind pickAppealCandidate: a
    // ghost-flagged roll is never installed, even if a rescue verdict
    // for it already exists in qc_second_opinions (recorded by the
    // shadow queue before this gate, or by any future selection bug).
    if (isGhostFlagged(cand)) {
      console.log(`inline appeal for ${slug} ${chapter ?? "?"}p${page ?? "?"}: ${APPEAL_GHOST_GATE_REASON} (attempt ${cand.id})`);
      await emitEvent(env, {
        slug,
        kind: "appeal",
        event: "appeal_blocked_ghost_gate",
        detail: { reason: APPEAL_GHOST_GATE_REASON, blockedAttemptIds: [cand.id], chapter, page, kind },
      });
      return { rescued: false, verdict, attemptId: cand.id };
    }
    if (!bytes) {
      const obj = await env.BOOKS.get(cand.image_key);
      if (!obj) return { rescued: false, verdict, attemptId: cand.id };
      bytes = new Uint8Array(await obj.arrayBuffer());
    }
    return { rescued: true, bytes, verdict, attemptId: cand.id };
  } catch (e: any) {
    console.log(`inline appeal failed for ${slug} ${chapter ?? "?"}p${page ?? "?"}: ${e?.message ?? e}; page holds as before`);
    return { rescued: false };
  }
}

export async function handleAppealsBatch(batch: any, env: any): Promise<void> {
  for (const msg of batch.messages) {
    const { attemptId, slug } = msg.body ?? {};
    try {
      const seen: any = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM qc_second_opinions WHERE attempt_id=? AND judge_model=?"
      )
        .bind(attemptId, JUDGE_MODEL)
        .first();
      if ((seen?.n ?? 0) > 0) {
        msg.ack(); // redelivery: verdict already recorded
        continue;
      }
      const j = await judgeAttempt(env, attemptId);
      await recordOpinion(env, j, attemptId, slug);
      msg.ack();
    } catch (e) {
      console.log(`appeal judge failed for attempt ${attemptId} (delivery ${msg.attempts}): ${String((e as any)?.message ?? e)}`);
      emitAppealMetric(env, slug ?? "unknown", JUDGE_MODEL, "judge_error", 0);
      msg.retry();
    }
  }
}
