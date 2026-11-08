// Vercel AI Gateway image generation (Nano Banana family).
//
// The factory's color image station. Text models still run on the
// Gemini/Workers AI chain in models.ts; page art for the picture book
// runs here when AI_GATEWAY_KEY is set as a worker secret, and every
// caller degrades gracefully to the Flux line-art path when it is not.
//
// Request/response shape mirrors the verified gateway helper
// (custom-connectors/custom.vercel-ai-gateway/bin/gateway.py): chat
// completions with modalities ["text","image"], reference sheets as
// data-URL image parts, Google imageConfig pinned to 3:4 / 2K.

export const GATEWAY_MODEL = "google/gemini-nano-banana-2.1";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

export interface GatewayEnv {
  AI_GATEWAY_KEY?: string;
  AI_GATEWAY_IMAGE_MODEL?: string;
  // Google-direct Interactions transport (opt-in): set IMAGE_TRANSPORT
  // to "interactions" and provide a Google AI Studio key. The gateway
  // path above stays the default and the fallback.
  GEMINI_API_KEY?: string;
  GEMINI_IMAGE_MODEL?: string;
  IMAGE_TRANSPORT?: string;
  // Optional flat per-image USD estimate for interactions metering
  // until the live usage shape is verified (see the transport below).
  INTERACTIONS_COST_PER_IMAGE_USD?: string;
  // "flex" | "standard" | "priority" for the interactions transport.
  // Flex is 50% off standard in exchange for 1-15 minute latency and
  // best-effort capacity (Google docs, flex inference). The factory is
  // a batch pipeline, so latency is the cheap currency here.
  IMAGE_SERVICE_TIER?: string;
}

export function gatewayConfigured(env: GatewayEnv): boolean {
  return !!env?.AI_GATEWAY_KEY;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function imageFromString(s: string): Uint8Array | null {
  if (!s) return null;
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma < 0) return null;
    return b64ToBytes(s.slice(comma + 1));
  }
  // Raw base64 (long, no whitespace) is the only other shape we accept.
  if (s.length > 200 && !s.includes(" ") && !s.startsWith("http")) {
    try {
      return b64ToBytes(s);
    } catch {
      return null;
    }
  }
  return null;
}

// Pull the first generated image out of a chat-completions response.
// The gateway returns it under message.images (data URLs or objects);
// content parts are the fallback shape.
export function extractGatewayImage(resp: any): Uint8Array | null {
  const msg = resp?.choices?.[0]?.message ?? {};
  for (const key of ["images", "image", "files"]) {
    const v = msg[key];
    if (!v) continue;
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      if (typeof item === "string") {
        const b = imageFromString(item);
        if (b) return b;
        continue;
      }
      const s =
        item?.image_url?.url ?? item?.url ?? item?.b64_json ?? item?.data ?? "";
      const b = imageFromString(String(s ?? ""));
      if (b) return b;
    }
  }
  const parts = Array.isArray(msg.content) ? msg.content : [];
  for (const p of parts) {
    if (p?.type === "image" || p?.type === "image_url" || p?.type === "output_image") {
      const s = p?.image_url?.url ?? p?.b64_json ?? p?.data ?? "";
      const b = imageFromString(String(s ?? ""));
      if (b) return b;
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Google-direct Interactions transport (CG, 2026-11-07).
//
// The gateway chat-completions shape above is a compatibility shim for
// this model family: it silently ignores imageConfig (we request 2K,
// every archived roll is the 1K size, 896x1200). The native surface is
// the Interactions API (POST generativelanguage.googleapis.com/v1beta/
// interactions), where aspect ratio and image size are first-class
// response_format fields and, the real prize, edits are multi-turn:
// a follow-up call passes previous_interaction_id plus a plain
// directive ("fix exactly this, change nothing else") and the model
// edits its own previous output with the whole conversation (prompt,
// reference sheets, its drawing) in context. Our QC edit pass is
// exactly that pattern, currently faked with a cold resend.
//
// Opt-in by env: IMAGE_TRANSPORT=interactions + GEMINI_API_KEY secret.
// Everything degrades to the gateway path when either is absent.
// Metering: the gateway returns usage.cost; the interactions response
// shape for cost is not yet verified live, so cost falls back to the
// INTERACTIONS_COST_PER_IMAGE_USD flat estimate when configured, else
// null (the proof run's first live response settles the real shape
// before this transport may become the default).
const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const INTERACTIONS_MODEL = "gemini-nano-banana-2.1";

export function interactionsTransportOn(env: GatewayEnv): boolean {
  return env?.IMAGE_TRANSPORT === "interactions" && !!env?.GEMINI_API_KEY;
}

export interface ImageGenOpts {
  // Continue a previous interactions conversation (multi-turn edit).
  // When set, refBytes are ignored: the conversation already holds
  // the prompt, the sheets, and the image being edited.
  previousInteractionId?: string;
  // "1K" | "2K" | "4K" (interactions transport only; the gateway
  // path's pinned size lives in its own request body).
  imageSize?: string;
  // Per-call service tier override; defaults to IMAGE_SERVICE_TIER.
  serviceTier?: string;
}

export async function generateInteractionsImageMetered(
  env: GatewayEnv,
  prompt: string,
  refBytes: (Uint8Array | null | undefined)[] = [],
  aspect: string = "3:4",
  opts: ImageGenOpts = {}
): Promise<{ bytes: Uint8Array; cost: number | null; interactionId: string | null }> {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY secret not set");
  const chained = !!opts.previousInteractionId;
  const input: any[] = [{ type: "text", text: prompt }];
  if (!chained) {
    const refs = refBytes.filter((b): b is Uint8Array => !!b && b.length > 0).slice(0, 4);
    for (const r of refs) {
      const isPng = r[0] === 0x89 && r[1] === 0x50;
      input.push({
        type: "image",
        data: bytesToB64(r),
        mime_type: isPng ? "image/png" : "image/jpeg",
      });
    }
  }
  const body: any = {
    model: env.GEMINI_IMAGE_MODEL || INTERACTIONS_MODEL,
    input,
    response_format: {
      type: "image",
      mime_type: "image/png",
      aspect_ratio: aspect,
      image_size: opts.imageSize || "1K",
    },
  };
  if (chained) body.previous_interaction_id = opts.previousInteractionId;
  const tier = opts.serviceTier || env.IMAGE_SERVICE_TIER;
  if (tier) body.service_tier = tier;
  // Flex queues: Google recommends 10+ minute client timeouts. The
  // roll loop treats a timeout/503 as an ordinary failed roll (the
  // doc's own client-side retry shape); a flex request is never
  // silently upgraded to standard, so a shed roll costs nothing.
  const timeoutMs = tier === "flex" ? 600000 : 300000;
  const res = await fetch(INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
      "Api-Revision": "2026-05-20",
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`interactions HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const resp: any = await res.json();
  let b64: string | null = resp?.output_image?.data ?? null;
  if (!b64 && Array.isArray(resp?.steps)) {
    // Interleaved outputs nest image blocks inside steps.
    for (const step of resp.steps) {
      const parts = Array.isArray(step?.content) ? step.content : [];
      for (const p of parts) {
        if (p?.type === "image" && typeof p?.data === "string") { b64 = p.data; break; }
      }
      if (b64) break;
    }
  }
  if (!b64) throw new Error("interactions response carried no image");
  const bytes = b64ToBytes(b64);
  let cost: number | null = typeof resp?.usage?.cost === "number" ? resp.usage.cost : null;
  if (cost === null) {
    const flat = Number(env.INTERACTIONS_COST_PER_IMAGE_USD);
    if (Number.isFinite(flat) && flat > 0) cost = flat;
  }
  if (resp?.usage) console.log(`interactions usage: ${JSON.stringify(resp.usage).slice(0, 300)}`);
  return { bytes, cost, interactionId: typeof resp?.id === "string" ? resp.id : null };
}

// Generate one image. Dispatches to the Google-direct Interactions
// transport when it is switched on, otherwise the gateway. refBytes
// are character sheets (PNG or JPEG); the model conditions on them
// the same way Flux did, only much better at holding the character.
export async function generateGatewayImageMetered(
  env: GatewayEnv,
  prompt: string,
  refBytes: (Uint8Array | null | undefined)[] = [],
  aspect: string = "3:4",
  opts: ImageGenOpts = {}
): Promise<{ bytes: Uint8Array; cost: number | null; interactionId: string | null }> {
  if (interactionsTransportOn(env)) {
    return generateInteractionsImageMetered(env, prompt, refBytes, aspect, opts);
  }
  if (opts.previousInteractionId) {
    throw new Error("multi-turn edits need the interactions transport (IMAGE_TRANSPORT=interactions + GEMINI_API_KEY)");
  }
  const key = env.AI_GATEWAY_KEY;
  if (!key) throw new Error("AI_GATEWAY_KEY secret not set");
  const refs = refBytes.filter((b): b is Uint8Array => !!b && b.length > 0).slice(0, 4);
  const content: any[] = [{ type: "text", text: prompt }];
  for (const r of refs) {
    const isPng = r[0] === 0x89 && r[1] === 0x50;
    content.push({
      type: "image_url",
      image_url: { url: `data:${isPng ? "image/png" : "image/jpeg"};base64,${bytesToB64(r)}` },
    });
  }
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(300000),
    body: JSON.stringify({
      model: env.AI_GATEWAY_IMAGE_MODEL || GATEWAY_MODEL,
      messages: [{ role: "user", content }],
      modalities: ["text", "image"],
      providerOptions: {
        google: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: aspect, imageSize: "2K" },
        },
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`gateway HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const resp: any = await res.json();
  const bytes = extractGatewayImage(resp);
  if (!bytes) throw new Error("gateway response carried no image");
  const cost = typeof resp?.usage?.cost === "number" ? resp.usage.cost : null;
  if (cost) console.log(`gateway image cost: $${cost}`);
  return { bytes, cost, interactionId: null };
}

export async function generateGatewayImage(
  env: GatewayEnv,
  prompt: string,
  refBytes: (Uint8Array | null | undefined)[] = [],
  aspect: string = "3:4"
): Promise<Uint8Array> {
  const { bytes } = await generateGatewayImageMetered(env, prompt, refBytes, aspect);
  return bytes;
}

// House color style for picture-book pages, matching the approved
// bake-off sheets and scenes (soft watercolor storybook).
export const COLOR_PAGE_STYLE =
  "Children's picture book illustration, soft watercolor storybook style, " +
  "warm rich colors, detailed background, gentle light. Simple kid-friendly " +
  "shapes for ages 4 to 8, portrait orientation. No text, no words, no " +
  "letters, no numbers anywhere in the image.";

// Plan prompts are written for the line-art pipeline (they open with
// "Bold clean outlines, no shading..." and ban color words). For the
// color twin, strip the line-art directives and let the style carry the
// palette; the scene description itself stays the plan's.
export function colorizePrompt(planPrompt: string): string {
  let p = String(planPrompt ?? "");
  p = p.replace(/^bold clean outlines[^.]*\.\s*/i, "");
  p = p.replace(/\bblack-and-white line art\b/gi, "color illustration");
  p = p.replace(/\bline art\b/gi, "illustration");
  p = p.replace(/\bno shading\b/gi, "");
  p = p.replace(/\bno gray fills\b/gi, "");
  p = p.replace(/\bwide white margins\b/gi, "");
  p = p.replace(/\s{2,}/g, " ").trim();
  return p;
}

// Full prompt for one color page: reference instruction (when sheets
// exist), the plan's scene, then the house style.
export function colorPagePrompt(planPrompt: string, hasRefs: boolean): string {
  const refLead = hasRefs
    ? "Use the characters from the reference sheets exactly: same species, " +
      "same body shape and proportions, same face, same signature clothing " +
      "or accessory. "
    : "";
  return `${refLead}${colorizePrompt(planPrompt)} ${COLOR_PAGE_STYLE}`;
}

// ------------------------------------------------------------------
// Jev (TypeSafe AI System One) through the gateway's v4 evaluation
// endpoint. Jev is a DECISION model, not a language model: chat
// completions 400 with "use the decision generation API instead".
// Verified live 2026-10-24: POST /v4/ai/evaluation-model with the
// ai-model-id + specification headers below; question types on this
// route are boolean | score | choice | box (no noul; that is the
// Workers AI shape Clef uses). State is shared text (plus optional
// image URL parts); answers come back as probabilities / scores.
// Price at test time: $0.042 per 1M input tokens, output free, ~0.6s.
// Vision calibration on our art was mushy (0.4-0.7 on everything), so
// Jev gates story TEXT here; Clef keeps image QC.
export const JEV_MODEL = "typesafe-ai/jev-1.14.0";

export async function gatewayDecide(
  env: GatewayEnv & { AI_GATEWAY_JEV_MODEL?: string },
  state: string,
  questions: Record<string, any>
): Promise<Record<string, any>> {
  const key = env.AI_GATEWAY_KEY;
  if (!key) throw new Error("AI_GATEWAY_KEY secret not set");
  const res = await fetch("https://ai-gateway.vercel.sh/v4/ai/evaluation-model", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "ai-model-id": env.AI_GATEWAY_JEV_MODEL || JEV_MODEL,
      "ai-evaluation-model-specification-version": "4",
      "ai-gateway-protocol-version": "0.0.1",
    },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ state, questions }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`jev decide HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const resp: any = await res.json();
  // Meter the decision call (Jev bills per input token and the
  // response carries no usage block, so estimate input tokens from
  // the payload at ~4 chars per token). Dynamic import keeps this
  // module free of a static cycle with models.ts.
  try {
    const { logTextEvent } = await import("./models");
    const chars = state.length + JSON.stringify(questions).length;
    await logTextEvent(env as any, "jev", "jev-gate", null, {
      input_tokens: Math.ceil(chars / 4),
      output_tokens: 0,
      cost_usd: null,
    });
  } catch { /* metering never breaks a decision */ }
  return resp?.answers ?? {};
}

// Line-art twin prompt for Nano Banana: CG banned Flux 2 Klein 4B
// outright (2026-10-24), so the same gateway artist that draws the
// color pages also draws their black-and-white twins, conditioned on
// the approved character sheets. Plan imagePrompts are already written
// in line-art language; the style block below pins the rendering.
export const LINE_PAGE_STYLE =
  "Render as a clean black and white line art coloring page for kids: " +
  "bold black outlines only on a pure white background, absolutely no " +
  "color, no shading, no gray fills, wide white margins. No text, no " +
  "words, no letters, no numbers anywhere in the image.";

export function lineArtPrompt(planPrompt: string, hasRefs: boolean): string {
  const refLead = hasRefs
    ? "Use the characters from the reference sheets exactly: same species, " +
      "same body shape and proportions, same face, same signature clothing " +
      "or accessory. "
    : "";
  return `${refLead}${String(planPrompt ?? "")} ${LINE_PAGE_STYLE}`;
}

// ------------------------------------------------------- structured scenes
//
// Plans carry a structured scene per page (planv3): cast with counts,
// one action each, a GENERIC setting description, plain props, and a
// color script for the later colorize step. The image prompt is
// assembled here, in code, from that structure: species and visuals
// come from the bible, the cast count is stated outright, and no
// character or place NAME ever reaches the artist (names come back as
// lettering on signs: "Bramblebrrow", "BELLWATTER / SOPAARE").
export interface SceneCast {
  name: string;
  doing?: string;
}
export interface Scene {
  cast?: SceneCast[];
  setting?: string;
  props?: string[];
  colorScript?: Record<string, string>;
}

export function linePromptFromScene(scene: Scene, bible: any): string {
  const chars: any[] = bible?.characters ?? [];
  const byName = (n: string) =>
    chars.find((c) => String(c.name).toLowerCase() === String(n).toLowerCase());
  const cast = (scene?.cast ?? []).filter((c) => c?.name);
  const who = cast
    .map((c) => {
      const sp = byName(c.name);
      const species = sp?.species ?? "animal";
      const vis = sp?.visual ? ` (${sp.visual})` : "";
      const doing = String(c.doing ?? "is in the scene").replace(/\.\s*$/, "");
      return `one ${species}${vis}. It ${doing}.`;
    })
    .join(" ");
  const total = cast.length;
  const parts = [
    total
      ? `Exactly ${total} animal${total > 1 ? "s" : ""} in this image, each drawn exactly once: ${who}`
      : who,
    scene?.setting ? `Setting: ${scene.setting}.` : "",
    scene?.props?.length ? `Plain unmarked props: ${scene.props.slice(0, 3).join(", ")}.` : "",
    "One single scene, one moment, no character sheet, no repeated figures, no people.",
  ].filter(Boolean);
  return parts.join(" ");
}

// The color script the planner attached to the scene, handed to the
// colorize step so colors come from the plan instead of being
// improvised per roll (the drift CG found in Fern's color edition).
export function colorizeExtra(scene?: Scene | null): string {
  const cs = scene?.colorScript;
  if (!cs || !Object.keys(cs).length) return "";
  const lines = Object.entries(cs)
    .map(([k, v]) => `${k}: ${v}.`)
    .join(" ");
  return ` Use exactly these colors. ${lines} Do not add or duplicate any character.`;
}
