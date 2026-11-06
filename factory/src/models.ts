import { emitTextMetric } from "./metrics";
// Model chains, split by role (locked by CG 2026-10-24 after the Penny S5
// head-to-head test; full report in ~/workspace/bookqueue/model-test/):
//
// WRITER (bible, planner drafts, book info): Opus 5.5 via the gateway
// first, then Gemini direct, then the Workers AI bench. Opus was the
// only writer that produced a real chapter on the first attempt, twice
// (~$0.10 a chapter). GLM 5.3 cannot draft chapters here: at 16K and
// 32K token budgets it spent everything on hidden reasoning and
// returned empty content (0 for 2 in the test).
//
// JUDGE (the chapter critic): Opus first since the 2026-10-28 text-stack
// redesign (Phase 1 of the factory rethink). GLM 5.3 came OUT of the
// default chain: its verdicts agreed with Opus's on every major defect
// in the S5 test but filed only a subset of the issues, and the defects
// it waved through (a computer in Wally's animal harbor) cost more in
// downstream art re-rolls than the judging ever saved. GLM is still
// callable via the JUDGE_ORDER env override. Opus also keeps its
// acceptance seat (callOpusAcceptance), one look per chapter that has
// already passed, in planChapterAttempt.
//
// Jev is not a chat model at all (it is a decision model); its gate
// lives in gateway.ts (gatewayDecide) and planv3.ts uses it directly.

const OPUS_MODEL = "anthropic/claude-opus-5.5";
const GLM_MODEL = "@cf/zai-org/glm-5.3";
export const GEMINI_MODEL = "gemini-3.8-flash";
const DEEPSEEK_MODEL = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
const V4FLASH_MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";
const GEMMA_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export interface ModelResult {
  data: any;
  model: string;
}

// Token usage for one text call, when the provider reports it. cost is
// the provider-reported USD cost when the response carries one (the
// Vercel gateway does on some routes); otherwise it is derived from
// TEXT_PRICING when both token counts are known.
export interface TextUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

// Approximate USD list prices per 1M tokens, used ONLY to derive a
// ledger estimate in text_events when a provider reports tokens but no
// cost. Workers AI models bill in neurons on the account's credits, so
// they carry no per-token USD price here (null = not derivable).
export const TEXT_PRICING: Record<string, { in: number; out: number } | null> = {
  opus: { in: 15, out: 75 },
  gemini: { in: 0.5, out: 3 },
  jev: { in: 0.042, out: 0 },
  glm: null,
  v4flash: null,
  deepseek: null,
  gemma: null,
};

function deriveCost(model: string, usage: TextUsage): number | null {
  if (typeof usage.cost_usd === "number") return usage.cost_usd;
  const p = TEXT_PRICING[model];
  if (!p || usage.input_tokens === null || usage.output_tokens === null) return null;
  return (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1_000_000;
}

export interface MeterCtx {
  slug?: string;
  purpose?: string;
}

// ------------------------------------------------------------ text metering
//
// One row per text-model call in D1 text_events (the text sibling of
// gen_events' image metering, added 2026-10-28). Before this, text
// spend was a blind spot: the gateway balance moved and nobody could
// say which model, stage, or book moved it. Metering is best-effort by
// design: it wraps in try/catch and NEVER breaks the call it measures.
let textTableReady = false;
export async function logTextEvent(
  env: any,
  model: string,
  purpose: string,
  slug: string | null,
  usage: TextUsage
): Promise<void> {
  try {
    if (!env?.DB) return;
    if (!textTableReady) {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS text_events (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, purpose TEXT, slug TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, created_at INTEGER)"
      ).run();
      textTableReady = true;
    }
    await env.DB.prepare(
      "INSERT INTO text_events (model, purpose, slug, input_tokens, output_tokens, cost_usd, created_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind(
        model,
        purpose,
        slug,
        usage.input_tokens,
        usage.output_tokens,
        deriveCost(model, usage),
        Math.floor(Date.now() / 1000)
      )
      .run();
    emitTextMetric(env, slug, model, purpose, deriveCost(model, usage), usage.input_tokens, usage.output_tokens);
  } catch {
    // metering must never break a model call
  }
}

function extractJson(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model response: " + text.slice(0, 300));
  return JSON.parse(m[0]);
}

// Workers AI binding shapes disagree per model. Handle both. A response
// with reasoning but no content throws: chain-of-thought is never used
// as output (house rule, learned 2026-09-25).
function extractText(r: any): string {
  const msg = r?.choices?.[0]?.message;
  if (msg) {
    const content = msg.content;
    if (content && String(content).trim()) return String(content);
    const rcLen = msg.reasoning_content ? String(msg.reasoning_content).length : 0;
    throw new Error(
      `model returned reasoning only, no content (finish_reason=${r.choices[0].finish_reason}, ${rcLen} reasoning chars)`
    );
  }
  if (typeof r?.response === "string") return r.response;
  throw new Error("unrecognized model response shape");
}

interface RawResult {
  data: any;
  usage: TextUsage;
}

const NO_USAGE: TextUsage = { input_tokens: null, output_tokens: null, cost_usd: null };

function workersAiUsage(r: any): TextUsage {
  const u = r?.usage;
  if (!u) return NO_USAGE;
  return {
    input_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
    output_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
    cost_usd: null,
  };
}

async function callGeminiRaw(env: any, prompt: string, maxTokens: number): Promise<RawResult> {
  const key = env.GEMINI_API_KEY;
  if (!key) {
    console.log("model chain: GEMINI_API_KEY secret not set, skipping gemini");
    throw new Error("gemini skipped: no GEMINI_API_KEY secret");
  }
  // gemini-3.8-flash and 3.7-flash were both 503ing on capacity all day
  // 2026-10-22 (verified via the API: models exist, just UNAVAILABLE);
  // CG picked 3.6-flash, verified answering. A bare 503 throw drops the
  // chain into the slow Workers AI fallbacks, which blow the plan steps'
  // timeouts and kill the whole run, so retry 429/503 in-call with
  // backoff first; only then fall through to the chain.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(150000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.7,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    if (res.ok) break;
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      console.log(`gemini HTTP ${res.status}, retrying (attempt ${attempt + 2} of 3)`);
      await new Promise((r) => setTimeout(r, attempt === 0 ? 20000 : 45000));
      continue;
    }
    throw new Error(`gemini HTTP ${res.status}`);
  }
  if (!res || !res.ok) throw new Error(`gemini HTTP ${res?.status ?? "unknown"}`);
  const d: any = await res.json();
  const text = (d.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p.text ?? "")
    .join("");
  const um = d.usageMetadata ?? {};
  return {
    data: extractJson(text),
    usage: {
      input_tokens: typeof um.promptTokenCount === "number" ? um.promptTokenCount : null,
      output_tokens: typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : null,
      cost_usd: null,
    },
  };
}

// Opus 5.5 through the Vercel AI Gateway (gateway-only model). A 402
// (empty balance) throws and the writer chain falls through to Gemini,
// the same degrade path Luna used.
async function callOpusRaw(env: any, prompt: string, maxTokens: number): Promise<RawResult> {
  const key = env.AI_GATEWAY_KEY;
  if (!key) {
    console.log("model chain: AI_GATEWAY_KEY secret not set, skipping opus");
    throw new Error("opus skipped: no AI_GATEWAY_KEY secret");
  }
  const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(300000),
    body: JSON.stringify({
      model: OPUS_MODEL,
      messages: [{ role: "user", content: prompt }],
      // Floor 16384, NOT 4096: measured Opus chapter drafts run 5.4K to
      // 5.8K completion tokens, so the first deployed floor truncated
      // every chapter JSON mid-object, extractJson threw, and the
      // writer chain silently fell through to Gemini and the bench for
      // all 5 attempts of Penny's S5 re-fire (2026-10-24). The chapter
      // never got an Opus draft. Judging calls are smaller but the same
      // floor is harmless there.
      max_tokens: Math.max(maxTokens, 16384),
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`opus HTTP ${res.status}`);
  const d: any = await res.json();
  let text: any = d.choices?.[0]?.message?.content ?? "";
  if (Array.isArray(text)) {
    text = text.map((p: any) => p?.text ?? "").join("");
  }
  const u = d.usage ?? {};
  return {
    data: extractJson(String(text)),
    usage: {
      input_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
      output_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
      cost_usd: typeof u.cost === "number" ? u.cost : null,
    },
  };
}

export async function callOpus(env: any, prompt: string, maxTokens: number): Promise<any> {
  const { data } = await callOpusRaw(env, prompt, maxTokens);
  return data;
}

// The acceptance seat: one Opus look at a chapter that already passed
// the judge chain. Same caller, named for its role at call sites.
export async function callOpusAcceptance(env: any, prompt: string, meter?: MeterCtx): Promise<any> {
  const { data, usage } = await callOpusRaw(env, prompt, 4096);
  await logTextEvent(env, "opus", meter?.purpose ?? "acceptance", meter?.slug ?? null, usage);
  return data;
}

// GLM 5.3 on Workers AI: the judge. Token floor 32768 because its
// reasoning bills against the budget (the S5 test: judging prompts
// answered fine, drafting prompts starved even at 32K, which is why
// GLM judges and never writes here). extractText throws on
// reasoning-only responses, so a starved call falls through the chain.
async function callGlmRaw(env: any, prompt: string, maxTokens: number): Promise<RawResult> {
  const r: any = await env.AI.run(GLM_MODEL, {
    messages: [{ role: "user", content: prompt }],
    max_tokens: Math.max(maxTokens, 32768),
    temperature: 0.6,
  });
  const text = extractText(r).replace(/<think>[\s\S]*?<\/think>/g, "");
  return { data: extractJson(text), usage: workersAiUsage(r) };
}

async function callDeepseekRaw(env: any, prompt: string, maxTokens: number): Promise<RawResult> {
  const r: any = await env.AI.run(DEEPSEEK_MODEL, {
    messages: [{ role: "user", content: prompt }],
    max_tokens: Math.max(maxTokens, 8192),
    temperature: 0.6,
  });
  const text = extractText(r).replace(/<think>[\s\S]*?<\/think>/g, "");
  return { data: extractJson(text), usage: workersAiUsage(r) };
}

async function callV4FlashRaw(env: any, prompt: string, maxTokens: number): Promise<RawResult> {
  const r: any = await env.AI.run(V4FLASH_MODEL, {
    messages: [{ role: "user", content: prompt }],
    // Reasoning model: reasoning eats the token budget (verified: 8192
    // starves, 16384 works). Strip any <think> block, then require JSON.
    max_tokens: Math.max(maxTokens, 16384),
    temperature: 0.6,
  });
  const text = extractText(r).replace(/<think>[\s\S]*?<\/think>/g, "");
  return { data: extractJson(text), usage: workersAiUsage(r) };
}

async function callGemmaRaw(env: any, prompt: string, maxTokens: number): Promise<RawResult> {
  const r: any = await env.AI.run(GEMMA_MODEL, {
    messages: [{ role: "user", content: prompt }],
    // Gemma reasons by default and reasoning eats the token budget;
    // give it generous headroom (verified: 4096 starves, 16384 works).
    max_tokens: Math.max(maxTokens, 16384),
    temperature: 0.7,
  });
  return { data: extractJson(extractText(r)), usage: workersAiUsage(r) };
}

export type ModelRole = "writer" | "judge" | "hands";

export function writerOrder(env: any): string[] {
  return String(env.WRITER_ORDER ?? "opus,gemini,v4flash,deepseek,gemma")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function judgeOrder(env: any): string[] {
  return String(env.JUDGE_ORDER ?? "opus,gemini,v4flash,deepseek,gemma")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Back-compat alias: the writer chain is the default chain.
export function plannerOrder(env: any): string[] {
  return writerOrder(env);
}

// The "hands" chain: cheap, competent models for delegated piecework
// (casting, outlines, term mapping, list work) under the staged bible
// build. Frontier models head the writer chain for reading and the
// ladder; the hands never carry those. Env-tweakable like the others.
export function handsOrder(env: any): string[] {
  return String(env.HANDS_ORDER ?? "gemini,v4flash,deepseek,gemma")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const FNS: Record<string, (env: any, prompt: string, maxTokens: number) => Promise<RawResult>> = {
  opus: callOpusRaw,
  glm: callGlmRaw,
  gemini: callGeminiRaw,
  v4flash: callV4FlashRaw,
  deepseek: callDeepseekRaw,
  gemma: callGemmaRaw,
};

export async function callModel(
  env: any,
  prompt: string,
  maxTokens = 4096,
  role: ModelRole = "writer",
  meter?: MeterCtx
): Promise<ModelResult> {
  const order = role === "judge" ? judgeOrder(env) : role === "hands" ? handsOrder(env) : writerOrder(env);
  const errors: string[] = [];
  for (const name of order) {
    const fn = FNS[name];
    if (!fn) throw new Error(`unknown model in ${role} order: ${name}`);
    try {
      const { data, usage } = await fn(env, prompt, maxTokens);
      await logTextEvent(env, name, meter?.purpose ?? role, meter?.slug ?? null, usage);
      return { data, model: name };
    } catch (e: any) {
      const msg = `${name}: ${e?.message ?? String(e)}`.slice(0, 200);
      console.log(`model chain (${role}): ${msg} -> trying next model`);
      errors.push(msg);
    }
  }
  throw new Error(`all ${role} models failed: ` + errors.join(" | "));
}
