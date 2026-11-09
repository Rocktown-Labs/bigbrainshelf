// Shared Workers AI helpers for the kidsbook factory.

export const STYLE_SUFFIX =
  "Children's coloring page, black-and-white line art with bold clean outlines, " +
  "no shading and no gray fills. Simple kid-friendly shapes for ages 4 to 8, " +
  "portrait orientation, wide white margins. " +
  // OUTLINE-ONLY (CG, 2026-11-09): see LINE_PAGE_STYLE in gateway.ts.
  "Outline only: no solid black fills anywhere; black markings on a " +
  "character are drawn as outline boundaries with the inside left white.";

export const COLOR_STYLE =
  "Children's picture book illustration in full color, bright cheerful colors, " +
  "soft painted storybook style. Simple kid-friendly shapes for ages 4 to 8, " +
  "portrait orientation.";

export interface StoryBible {
  bookTitle: string;
  characters: { name: string; visual: string; wardrobe?: string }[];
  setting: string;
  metaphorFamily: string;
}

export interface PagePlan {
  character: string;
  concept: string;
  imagePrompt: string;
  storyText: string;
}

export interface ChapterPlan {
  storyTitle: string;
  pages: PagePlan[];
  finale: { imagePrompt: string; storyText: string };
}

const PLANNER = "@cf/qwen/qwen2.5-coder-32b-instruct";
// Flux 2 Klein 4B was the line artist until 2026-10-24, when CG banned
// it outright ("I don't want to use flux 2 klein 4b, AT ALL"). All page
// art now comes from the gateway's Nano Banana (see gateway.ts):
// generateImage draws the line-art twin, generateColorImage the color
// version, both conditioned on the approved character sheets.
import { generateGatewayImage, generateGatewayImageMetered, gatewayConfigured, lineArtPrompt, colorPagePrompt } from "./gateway";
import { GEMINI_MODEL, logTextEvent } from "./models";

export async function planChapter(
  AI: any,
  title: string,
  chapterText: string,
  pageCount: number,
  bible?: StoryBible
): Promise<ChapterPlan> {
  const bibleBlock = bible
    ? `The book's world (use these exact characters and setting in every scene so the art stays ` +
      `consistent): Book title: ${bible.bookTitle}. Characters: ${bible.characters
        .map((c) => `${c.name} (${c.visual})`)
        .join("; ")}. Setting: ${bible.setting}. Metaphor family for this book: ${bible.metaphorFamily}.\n`
    : "";
  const prompt =
    `You are an expert curriculum designer and children's book author. Turn this programming-book ` +
    `chapter into ${pageCount} kids coloring-book pages (ages 4-8), plus a finale. ` +
    bibleBlock +
    `The pages tell one short story that teaches the chapter's core concepts in simple words a ` +
    `5-year-old understands, using a physical metaphor (animals, toys, sports, marbles, games). ` +
    `Vary the metaphor from chapter to chapter; do not reuse the same metaphor twice in one book. ` +
    `The story must feel original: invent an original storybook title for this chapter ` +
    `(in the spirit of titles like "<Name> the <Animal> and the Great Picnic", but a fresh one for ` +
    `THIS chapter's story and characters; never reuse an example title and never repeat a title ` +
    `used for another chapter). NEVER cite, mention, or reference the source book's ` +
    `title or that this is adapted from a book. End the story with something being deployed ` +
    `(opened, launched, shipped, going live).\n` +
    `Hard rules for every imagePrompt (the art must print as clean black-and-white line art):\n` +
    `- Describe the scene with NO color words at all: never name colors, rainbows, or colored objects. ` +
    `Say "arched bands" not "rainbow", "a red crayon" becomes "a crayon".\n` +
    `- The image must contain NO text, letters, numbers, or words anywhere: no signs, labels, screens, ` +
    `shirts with writing, book covers with titles, name tags, banners, or chalkboards with words. ` +
    `Describe boxes, jars, and containers as plain and unmarked, never "labeled". ` +
    `If a scene needs a label, describe a blank one. Never put a character's name in the imagePrompt ` +
    `and never dress characters in clothing with marks or logos, the model renders names as text on them.\n` +
    `- One clear subject per page, bold clean outlines, no shading, no gray fills, wide white margins. ` +
    `Reuse the bible's characters with their exact visual descriptions so every page looks like the same world.\n` +
    `Reply with ONLY a JSON object shaped like ` +
    `{"storyTitle": "original storybook title for this chapter", ` +
    `"pages": [{"character": name, "concept": one sentence, "imagePrompt": one line describing the ` +
    `black-and-white line-art scene following the hard rules above, "storyText": 2-4 simple sentences ` +
    `teaching the concept}], "finale": {"imagePrompt": one line for the deployment celebration scene ` +
    `following the hard rules above, ` +
    `"storyText": 2-3 simple sentences ending the story with the deployment"}}. ` +
    `No em dashes in any text. Chapter text: ${chapterText.slice(0, 6000)}`;
  const r: any = await AI.run(PLANNER, {
    messages: [{ role: "user", content: prompt }],
    // Workers AI truncates this model's output at a small default budget;
    // the plan JSON needs room or it gets cut off mid-string.
    max_tokens: 4096,
  });
  const text = asText(r?.response ?? r);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("planner returned no JSON");
  return JSON.parse(m[0]) as ChapterPlan;
}

function asText(v: any): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    if (typeof v.content === "string") return v.content;
    if (typeof v.text === "string") return v.text;
    return JSON.stringify(v);
  }
  return String(v ?? "");
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Canonical character reference sheet location. Sheets are generated once per
// character (solo, full-body, white background) and stored in R2; page art is
// then conditioned on the sheet so the character stops drifting.
export function sheetKeyFor(slug: string, characterName: string): string {
  return `library/characters/${slug}/${characterName.trim().toLowerCase()}-sheet.jpg`;
}

const SPECIES_WORDS = [
  "whale", "otter", "seagull", "gull", "penguin", "fox", "bear", "cat", "dog",
  "bird", "fish", "crab", "snake", "gopher", "elephant", "owl", "frog",
  "mouse", "rabbit", "duck", "turtle", "crane", "stork", "pigeon", "swift",
  "squirrel", "songbird", "wren",
];

// Guarantee an art prompt carries the character's identity. Planner prompts
// are supposed to paste the character's visual verbatim, but fallback planners
// write short scene-only prompts, and the reference sheet alone cannot hold
// identity from those (a seagull came back as a human boy, the whale as a
// seal). If the species word is missing, prepend the bible's verbatim visual.
//
// EVERY character named in the scene gets anchored, not just the lead: the
// old lead-only version left supporting cast described by name only, and
// the artist cloned the lead for them (Moss the turtle drawn as a second
// fox, Fern S2 page 0, three times running).
export function anchoredPrompt(prompt: string, character: string | undefined, bible: any): string {
  if (!bible?.characters?.length) return prompt;
  const lower = prompt.toLowerCase();
  const blocks: string[] = [];
  for (const ch of bible.characters) {
    const name = String(ch?.name ?? "").trim();
    if (!name || !prompt.includes(name)) continue;
    const vis = ch?.visual ?? "";
    if (!vis) continue;
    const species = SPECIES_WORDS.filter((w) => vis.toLowerCase().includes(w));
    if (species.length && !species.some((w) => lower.includes(w))) {
      blocks.push(`${name}: ${vis}`);
    }
  }
  if (blocks.length) return `${blocks.join(". ")}. ${prompt}`;
  // Legacy fallback: nobody named in the prompt; anchor the declared lead.
  if (!character) return prompt;
  const name = String(character).replace(/[\[\]']/g, "").split(",")[0].trim();
  const ch = bible.characters.find((c: any) => c.name === name);
  const vis = ch?.visual ?? "";
  if (!vis) return prompt;
  const species = SPECIES_WORDS.filter((w) => vis.toLowerCase().includes(w));
  if (species.length && !species.some((w) => lower.includes(w))) {
    return `${vis}. ${prompt}`;
  }
  return prompt;
}

// Line-art page art via the gateway (Nano Banana line twin, sheet-
// referenced). Throws when the gateway is not configured: there is no
// silent fallback artist anymore, by design.
export async function generateImage(env: any, scene: string, refBytes?: Uint8Array | null): Promise<Uint8Array> {
  const { bytes } = await generateImageMetered(env, scene, refBytes);
  return bytes;
}

export async function generateImageMetered(env: any, scene: string, refBytes?: Uint8Array | Uint8Array[] | null): Promise<{ bytes: Uint8Array; cost: number | null }> {
  if (!gatewayConfigured(env)) throw new Error("line art needs the gateway: AI_GATEWAY_KEY secret not set");
  const refs = !refBytes ? [] : Array.isArray(refBytes) ? refBytes : [refBytes];
  return generateGatewayImageMetered(env, lineArtPrompt(scene, refs.length > 0), refs);
}

// Full-color variant (covers, back covers): same gateway artist, the
// color page prompt instead of the line twin.
export async function generateColorImage(env: any, scene: string, refBytes?: Uint8Array | null): Promise<Uint8Array> {
  const { bytes } = await generateColorImageMetered(env, scene, refBytes);
  return bytes;
}

export async function generateColorImageMetered(env: any, scene: string, refBytes?: Uint8Array | Uint8Array[] | null): Promise<{ bytes: Uint8Array; cost: number | null }> {
  if (!gatewayConfigured(env)) throw new Error("color art needs the gateway: AI_GATEWAY_KEY secret not set");
  const refs = !refBytes ? [] : Array.isArray(refBytes) ? refBytes : [refBytes];
  return generateGatewayImageMetered(env, colorPagePrompt(scene, refs.length > 0), refs);
}

// QC runs on the Clef family: the full 27B decision model first, the
// fast 9B Flash as fallback. (LLaVA was the old fallback; it waved
// through tiny text scribbles, so it is out of QC entirely.)
const CLEF = "@cf/cloudflare/clef";
const CLEF_MODEL = "clef";
const CLEF_FAST = "@cf/cloudflare/clef-flash";
const CLEF_FAST_MODEL = "clef-flash";

const QC_QUESTIONS = {
  has_text: { type: "noul", instructions: "Does this image contain any text, letters, numbers, or words drawn anywhere in it, even a single letter, including tiny labels, name tags, speech bubbles, stamps, or writing on objects?" },
  has_color: { type: "noul", instructions: "Does this image contain any color, shading, or gray fills (anything other than pure black lines on white)?" },
  is_lineart: { type: "noul", instructions: "Is this a clean black-and-white line-art coloring page for kids, with bold outlines and wide white margins?" },
};

export interface CastChar {
  name: string;
  species: string;
  visual?: string;
  // Optional signature outfit/accessory list from the bible. When a
  // character carries one, line QC asks whether the complete outfit is
  // drawn (Bix shipped bare-legged on pages where his bible text once
  // omitted his clothes entirely; CG, 2026-11-09: "Bix needs pants").
  wardrobe?: string;
}

// Cast-integrity propositions (2026-10-26, from the full-catalog visual
// verification): the older gates asked whether the cast was PRESENT and
// the right species, but never whether anyone appeared TWICE, whether
// the page was a scene at all, or whether a human had been substituted
// for an animal. Those three families shipped dozens of verified-bad
// pages: clones keyed on signature markings (four sailor-hat Skippers
// on one page), pose-sheet collages instead of scenes (three in Mira),
// and human children standing in for animal cast members (seven-plus
// pages). These questions ask each of those directly, per character.
function addCastIntegrityQuestions(questions: Record<string, any>, castList: CastChar[]): void {
  castList.slice(0, 3).forEach((c, i) => {
    const visual = String(c.visual ?? "").slice(0, 140);
    questions[`dupe_${i}`] = {
      type: "noul",
      instructions: `The character ${c.name} is a ${c.species}${visual ? `, described as: ${visual}` : ""}. Is ${c.name} drawn AT MOST ONCE in this image? Answer yes only if the character appears zero or one times, never two or more times in any pose or size. A reflection of the character in water or a mirror, and the character's shadow, do NOT count as another appearance.`,
    };
  });
  questions.single_scene = {
    type: "noul",
    instructions: "Is this image ONE single scene (one moment, in one place), and NOT a character study sheet, model sheet, or collage that shows the same character in several separate poses against a plain background?",
  };
  const humanCast = castList.some((c) => /human|person|boy|girl|child|man|woman|people/i.test(String(c.species ?? "")));
  if (!humanCast) {
    questions.no_humans = {
      type: "noul",
      // Background figures count (2026-11-09): Tilda's fair pages shipped
      // human silhouettes and tiny villagers in the background that the
      // foreground-only wording never caught.
      instructions: "Does this image contain NO human people, human children, human faces, or human hands anywhere in it, including small figures, silhouettes, or crowds in the background?",
    };
  }
  // Wardrobe completeness (2026-11-09): dupe/cast gates ask whether a
  // character is present and the right species, never whether their
  // outfit is complete. Asked only for characters whose bible entry
  // carries a wardrobe list, so books without wardrobe data are ungated.
  castList.slice(0, 3).forEach((c, i) => {
    const wardrobe = String(c.wardrobe ?? "").trim();
    if (!wardrobe) return;
    questions[`wardrobe_${i}`] = {
      type: "noul",
      instructions: `Is ${c.name} wearing or carrying their complete signature outfit: ${wardrobe}? Answer yes only if every listed item is present and visible on ${c.name} in this image.`,
    };
  });
  // Extra characters (2026-11-09): the dupe gates key on named cast
  // members, so an unnamed second bird of the lead's species (three
  // magpies at Tilda's fair) passed every gate. Foreground only:
  // distant background animals at a market or fair are scenery.
  const names = castList.map((c) => c.name).join(", ");
  questions.no_extra_characters = {
    type: "noul",
    instructions: `Are the only animals in the foreground of this image the cast members (${names}), with no additional animal of any species in the foreground, and in particular no second bird of the lead character's species?`,
  };
}

// Returns a reject reason, or null when every integrity answer holds.
function castIntegrityReject(a: any, castList: CastChar[], label: string): string | null {
  for (let i = 0; i < Math.min(3, castList.length); i++) {
    const p = a[`dupe_${i}`]?.noul ?? 1;
    if (p < 0.5) return `${label}: dupe check for ${castList[i].name} scored ${p.toFixed(2)} (character appears more than once)`;
  }
  const sceneP = a.single_scene?.noul ?? 1;
  if (sceneP < 0.5) return `${label}: single_scene scored ${sceneP.toFixed(2)} (pose-sheet or collage layout, not a scene)`;
  if (a.no_humans) {
    const humP = a.no_humans?.noul ?? 1;
    if (humP < 0.5) return `${label}: no_humans scored ${humP.toFixed(2)} (a human appears in an animal-cast book)`;
  }
  for (let i = 0; i < Math.min(3, castList.length); i++) {
    if (!a[`wardrobe_${i}`]) continue;
    const wp = a[`wardrobe_${i}`]?.noul ?? 1;
    if (wp < 0.5) return `${label}: wardrobe_complete for ${castList[i].name} scored ${wp.toFixed(2)} (signature outfit incomplete or missing)`;
  }
  if (a.no_extra_characters) {
    const xp = a.no_extra_characters?.noul ?? 1;
    if (xp < 0.5) return `${label}: no_extra_characters scored ${xp.toFixed(2)} (an extra animal appears in the foreground)`;
  }
  return null;
}

// Detailed QC verdict (2026-11-01, CG's reject-logging ask): every
// gate's score plus the first failing gate's reason, so a rejected
// roll can be reviewed later instead of vanishing. The boolean
// wrappers below keep the old call contract; the generation loops
// use the detailed forms and persist attempts via logGenAttempt.
export interface QcDetail {
  pass: boolean;
  scores: Record<string, number | null>;
  reason: string | null;
}

function scoresOf(a: any, questions: Record<string, any>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of Object.keys(questions)) {
    const v = a?.[k]?.noul;
    out[k] = typeof v === "number" ? v : null;
  }
  return out;
}

async function qcWithClef(
  AI: any,
  bytes: Uint8Array,
  sheetBytes?: Uint8Array | null,
  id: string = CLEF,
  model: string = CLEF_MODEL,
  castText?: string | null,
  castList?: CastChar[] | null
): Promise<QcDetail> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const ct = isPng ? "image/png" : "image/jpeg";
  const questions: Record<string, any> = { ...QC_QUESTIONS };
  // Outline-only + style gates (CG, 2026-11-09). The purity gate's
  // has_color question asks about gray fills, so solid BLACK fills
  // (a filled magpie hood, filled trousers) scored clean and shipped:
  // Tilda's installed pages measured 0.81-0.94 on a fills proposition
  // against 0.05 on clean pages. Line pages are coloring pages: every
  // region stays a white outline. The style gate exists because three
  // of Tilda's finales drifted chibi (0.18-0.31 against 0.6-0.88 on
  // good pages) and no gate asked about style at all.
  questions.outline_only = {
    type: "noul",
    instructions: "Is every region of this drawing a white outline region, with NO large area filled solid black anywhere: no filled black head, body, wing, garment, or trousers, only black outline lines on white?",
  };
  questions.style_match = {
    type: "noul",
    instructions: "Is this page drawn in a detailed storybook line-art style with realistic animal proportions, and NOT a simple chibi cartoon style with an oversized round head, huge eyes, and a small cute body?",
  };
  if (castText) {
    // Same anatomy + whole-cast species checks the color path runs: the
    // line path shipped a turtle drawn as a second fox (Fern S2 page 0,
    // twice) because its QC only ever compared the LEAD against a sheet.
    questions.anatomy = {
      type: "noul",
      instructions: "Does every animal in this image have correct, natural anatomy: exactly one tail per animal, the normal number of legs and ears, and no extra, missing, or duplicated body parts anywhere?",
    };
    questions.cast_match = {
      type: "noul",
      instructions: `The story says these characters appear in this scene: ${castText}. Is every named character present in the image, and is each one drawn as the correct species (for example, a character who should be a turtle must not be drawn as a fox)?`,
    };
  }
  if (castList?.length) addCastIntegrityQuestions(questions, castList);
  const images: any[] = [{ content_type: ct, base64: bytesToB64(bytes) }];
  if (sheetBytes) {
    questions.character_match = {
      type: "noul",
      instructions:
        "The SECOND image is the official character reference sheet. Does the main character in the FIRST image " +
        "match the reference character: same species, same body shape and proportions, same face, and the same " +
        "signature clothing or accessory? Answer about the character design only, not the scene.",
    };
    images.push({
      content_type: sheetBytes[0] === 0x89 && sheetBytes[1] === 0x50 ? "image/png" : "image/jpeg",
      base64: bytesToB64(sheetBytes),
    });
  }
  const r: any = await AI.run(id, {
    model,
    state: "A generated coloring-book page image is attached for quality control.",
    questions,
    images,
  });
  const a = r.answers ?? {};
  const scores = scoresOf(a, questions);
  const textP = a.has_text?.noul ?? 1;
  const colorP = a.has_color?.noul ?? 1;
  const lineP = a.is_lineart?.noul ?? 0;
  // The text bar is deliberately strict (0.12, not 0.3): the artist loves
  // sneaking in tiny name labels, and even the 27B Clef scores them low.
  if (!(textP <= 0.12 && colorP <= 0.3 && lineP >= 0.4)) {
    const reason = `line QC: has_text=${textP.toFixed(3)} (bar 0.12), has_color=${colorP.toFixed(3)} (bar 0.3), is_lineart=${lineP.toFixed(3)} (bar 0.4)`;
    console.log(`line QC reject: ${reason.slice(9)}`);
    return { pass: false, scores, reason };
  }
  if (sheetBytes) {
    const matchP = a.character_match?.noul ?? 0;
    if (matchP < 0.5) {
      const reason = `drift QC: character_match=${matchP.toFixed(2)} below 0.5`;
      console.log(`${reason}, rejecting`);
      return { pass: false, scores, reason };
    }
  }
  if (castText) {
    const anatomyP = a.anatomy?.noul ?? 1;
    // Line-path anatomy bar is 0.3, matching the color path
    // (2026-11-07; the color bar moved on CG's 2026-11-01 ruling).
    // The 0.5 bar rejected the noise band wholesale: the
    // gen_attempts archive holds 48 line anatomy rejects with a
    // median score of 0.39, and a shipped, human-verified Fenix
    // page replays at 0.386, while genuinely broken anatomy
    // (hand-shaped feet) measured 0.144. Scores in the band that
    // still fail now reach the inline appeal instead of parking.
    if (anatomyP < 0.3) {
      const reason = `anatomy QC (line): score=${anatomyP.toFixed(2)} below 0.3`;
      console.log(`${reason}, rejecting`);
      return { pass: false, scores, reason };
    }
    const castP = a.cast_match?.noul ?? 0;
    if (castP < 0.5) {
      const reason = `cast QC (line): cast_match=${castP.toFixed(2)} below 0.5`;
      console.log(`${reason}, rejecting`);
      return { pass: false, scores, reason };
    }
  }
  if (castList?.length) {
    const why = castIntegrityReject(a, castList, "cast integrity QC (line)");
    if (why) {
      console.log(`${why}, rejecting`);
      return { pass: false, scores, reason: why };
    }
  }
  const outlineP = a.outline_only?.noul ?? 1;
  if (outlineP < 0.5) {
    const reason = `line style QC: outline_only scored ${outlineP.toFixed(2)} (large solid black fills present; line pages are outline only)`;
    console.log(`${reason}, rejecting`);
    return { pass: false, scores, reason };
  }
  const styleP = a.style_match?.noul ?? 1;
  if (styleP < 0.5) {
    const reason = `line style QC: style_match scored ${styleP.toFixed(2)} (chibi or off-style rendering, not detailed storybook line art)`;
    console.log(`${reason}, rejecting`);
    return { pass: false, scores, reason };
  }
  return { pass: true, scores, reason: null };
}

export async function qcImageDetailed(AI: any, bytes: Uint8Array, sheetBytes?: Uint8Array | null, castText?: string | null, castList?: CastChar[] | null): Promise<QcDetail> {
  try {
    return await qcWithClef(AI, bytes, sheetBytes, CLEF, CLEF_MODEL, castText, castList);
  } catch (e) {
    console.log("Clef QC failed, falling back to Clef Flash:", (e as Error)?.message);
    try {
      return await qcWithClef(AI, bytes, sheetBytes, CLEF_FAST, CLEF_FAST_MODEL, castText, castList);
    } catch (e2) {
      console.log("Clef Flash QC failed too, rejecting the image:", (e2 as Error)?.message);
      return { pass: false, scores: {}, reason: "qc_error: both Clef chains failed" };
    }
  }
}

export async function qcImage(AI: any, bytes: Uint8Array, sheetBytes?: Uint8Array | null, castText?: string | null, castList?: CastChar[] | null): Promise<boolean> {
  return (await qcImageDetailed(AI, bytes, sheetBytes, castText, castList)).pass;
}

// Color-art QC: same strict text bar, but the art question asks for full
// color instead of line art. When a character sheet is supplied, the
// drift question (character_match >= 0.5) applies too, same as line QC:
// color pages carry the picture book, so drift matters most there.
// Same Clef chain (27B, then Flash, then reject).
async function qcColorWithClef(AI: any, bytes: Uint8Array, sheetBytes?: Uint8Array | null, id: string = CLEF, model: string = CLEF_MODEL, castText?: string | null, castList?: CastChar[] | null): Promise<QcDetail> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const ct = isPng ? "image/png" : "image/jpeg";
  const questions: Record<string, any> = {
    has_text: QC_QUESTIONS.has_text,
    is_color: {
      type: "noul",
      instructions: "Is this a full-color children's picture book illustration with bright, cheerful colors throughout (not black-and-white line art)?",
    },
    // Anatomy sanity: the color pipeline shipped a hero with two tails
    // on a cover page and it waved through (Fern S1, caught by the owner
    // 2026-10-23). Extra or duplicated body parts are a hard fail.
    anatomy: {
      type: "noul",
      instructions: "Does every animal in this image have correct, natural anatomy: exactly one tail per animal, the normal number of legs and ears, and no extra, missing, or duplicated body parts anywhere?",
    },
  };
  if (castText) {
    // Species presence for the WHOLE cast, not just the lead: the old
    // check compared only the main character against one sheet, so a
    // turtle drawn as a second fox passed (Fern S2 page 0).
    questions.cast_match = {
      type: "noul",
      instructions: `The story says these characters appear in this scene: ${castText}. Is every named character present in the image, and is each one drawn as the correct species (for example, a character who should be a turtle must not be drawn as a fox)?`,
    };
  }
  // Colorize multiplication guard: the color pass was verified filling
  // sparse solo pages with extra poses of the same character (Fern color
  // S7p2 shipped FIVE Orins from a one-Orin line page) because this QC
  // only ever checked presence. The dupe questions count.
  if (castList?.length) addCastIntegrityQuestions(questions, castList);
  const images: any[] = [{ content_type: ct, base64: bytesToB64(bytes) }];
  if (sheetBytes) {
    questions.character_match = {
      type: "noul",
      instructions:
        "The SECOND image is the official character reference sheet. Does the main character in the FIRST image " +
        "match the reference character: same species, same body shape and proportions, same face, and the same " +
        "signature clothing or accessory? Answer about the character design only, not the scene.",
    };
    images.push({
      content_type: sheetBytes[0] === 0x89 && sheetBytes[1] === 0x50 ? "image/png" : "image/jpeg",
      base64: bytesToB64(sheetBytes),
    });
  }
  const r: any = await AI.run(id, {
    model,
    state: "A generated full-color book illustration is attached for quality control.",
    questions,
    images,
  });
  const a = r.answers ?? {};
  const scores = scoresOf(a, questions);
  const textP = a.has_text?.noul ?? 1;
  const colorP = a.is_color?.noul ?? 0;
  if (!(textP <= 0.12 && colorP >= 0.5)) {
    const reason = `color QC: has_text=${textP.toFixed(3)} (bar 0.12), is_color=${colorP.toFixed(3)} (bar 0.5)`;
    console.log(`color QC reject: ${reason.slice(10)}`);
    return { pass: false, scores, reason };
  }
  const anatomyP = a.anatomy?.noul ?? 1;
  // Color-path anatomy bar is 0.3, not 0.5 (CG, 2026-11-01, from the
  // gen_attempts census): clean color pages score 0.316-0.564 against
  // this question while genuinely broken anatomy (hand-shaped feet)
  // scores 0.144, so the 0.5 bar coin-flipped good art and burned
  // rolls. The line path keeps its own 0.5 bar in qcWithClef.
  if (anatomyP < 0.3) {
    const reason = `anatomy QC: score=${anatomyP.toFixed(2)} below 0.3`;
    console.log(`${reason}, rejecting`);
    return { pass: false, scores, reason };
  }
  if (castText) {
    const castP = a.cast_match?.noul ?? 0;
    if (castP < 0.5) {
      const reason = `cast QC: cast_match=${castP.toFixed(2)} below 0.5`;
      console.log(`${reason}, rejecting`);
      return { pass: false, scores, reason };
    }
  }
  if (sheetBytes) {
    const matchP = a.character_match?.noul ?? 0;
    if (matchP < 0.5) {
      const reason = `drift QC (color): character_match=${matchP.toFixed(2)} below 0.5`;
      console.log(`${reason}, rejecting`);
      return { pass: false, scores, reason };
    }
  }
  if (castList?.length) {
    const why = castIntegrityReject(a, castList, "cast integrity QC (color)");
    if (why) {
      console.log(`${why}, rejecting`);
      return { pass: false, scores, reason: why };
    }
  }
  return { pass: true, scores, reason: null };
}

export async function qcColorImageDetailed(AI: any, bytes: Uint8Array, sheetBytes?: Uint8Array | null, castText?: string | null, castList?: CastChar[] | null): Promise<QcDetail> {
  try {
    return await qcColorWithClef(AI, bytes, sheetBytes, CLEF, CLEF_MODEL, castText, castList);
  } catch (e) {
    console.log("Clef color QC failed, falling back to Clef Flash:", (e as Error)?.message);
    try {
      return await qcColorWithClef(AI, bytes, sheetBytes, CLEF_FAST, CLEF_FAST_MODEL, castText, castList);
    } catch (e2) {
      console.log("Clef Flash color QC failed too, rejecting the image:", (e2 as Error)?.message);
      return { pass: false, scores: {}, reason: "qc_error: both Clef chains failed" };
    }
  }
}

export async function qcColorImage(AI: any, bytes: Uint8Array, sheetBytes?: Uint8Array | null, castText?: string | null, castList?: CastChar[] | null): Promise<boolean> {
  return (await qcColorImageDetailed(AI, bytes, sheetBytes, castText, castList)).pass;
}

// ---------------------------------------------------------------------
// Cast-listing judge (2026-10-27): a vision model asked for a FACTUAL
// LISTING of what is on the page, instead of Clef's yes/no probability
// propositions. The failure mode this targets is the dupe/clone family:
// Clef's "drawn at most once" question is a single proposition whose
// score straddles the bar on reflection-heavy and flock pages, while a
// listing ("three swifts") can be compared against the expected cast
// in plain code. ADVISORY until the offline corpus evaluation says
// otherwise: judgeCastListing returns null on any failure and callers
// must treat null as "no opinion", never as a pass or a fail.
// ---------------------------------------------------------------------

export interface CastListing {
  animals: { species: string; count: number }[];
  humans_or_humanoids: number;
  text_visible: boolean;
  text_found: string;
  single_scene: boolean;
  same_pose_repeated: boolean;
}

const CAST_LISTING_PROMPT =
  "Look at this children's book page and report ONLY what is drawn. " +
  "Answer with a single JSON object, no prose, with exactly these fields: " +
  '{"animals": [{"species": "<plain animal kind, e.g. swift, stork, pigeon, fox>", "count": <how many of that kind are drawn>}], ' +
  '"humans_or_humanoids": <number of human people, human children, or human-like figures>, ' +
  '"text_visible": <true if any letters, words, numbers, signs, or labels are drawn anywhere>, ' +
  '"text_found": "<the letters or words you can read, or empty string>", ' +
  '"single_scene": <true if this is one scene in one place, false if it is a character sheet, model sheet, or collage of separate poses>, ' +
  '"same_pose_repeated": <true if the exact same figure drawing appears more than once, copied>}. ' +
  "Count reflections in water or mirrors as part of the same animal, not a second animal. " +
  "Count shadows as part of the same animal too. If a kind of animal is not drawn, do not list it.";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function judgeCastListing(env: any, bytes: Uint8Array): Promise<CastListing | null> {
  const key = env?.GEMINI_API_KEY;
  if (!key) {
    console.log("cast listing judge: no GEMINI_API_KEY secret, no opinion");
    return null;
  }
  try {
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: isPng ? "image/png" : "image/jpeg", data: bytesToBase64(bytes) } },
                { text: CAST_LISTING_PROMPT },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    if (!res.ok) {
      console.log(`cast listing judge: gemini HTTP ${res.status}, no opinion`);
      return null;
    }
    const d: any = await res.json();
    await logTextEvent(env, "gemini", "cast-listing", null, {
      input_tokens: typeof d.usageMetadata?.promptTokenCount === "number" ? d.usageMetadata.promptTokenCount : null,
      output_tokens: typeof d.usageMetadata?.candidatesTokenCount === "number" ? d.usageMetadata.candidatesTokenCount : null,
      cost_usd: null,
    });
    const text = (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
      console.log("cast listing judge: no JSON in response, no opinion");
      return null;
    }
    const raw = JSON.parse(m[0]);
    return {
      animals: Array.isArray(raw.animals)
        ? raw.animals
            .filter((a: any) => a && typeof a.species === "string")
            .map((a: any) => ({ species: String(a.species).toLowerCase().trim(), count: Math.max(0, Math.floor(Number(a.count) || 0)) }))
        : [],
      humans_or_humanoids: Math.max(0, Math.floor(Number(raw.humans_or_humanoids) || 0)),
      text_visible: raw.text_visible === true,
      text_found: String(raw.text_found ?? ""),
      single_scene: raw.single_scene !== false,
      same_pose_repeated: raw.same_pose_repeated === true,
    };
  } catch (e: any) {
    console.log(`cast listing judge failed (${e?.message ?? e}), no opinion`);
    return null;
  }
}

// Pure comparison: does the listing match the expected cast? Expected
// entries carry the count the scene wants (usually 1 per named cast
// member). Species match is substring-tolerant both ways ("swift" vs
// "common swift"). Returns a reject reason, or null when it matches.
// NOT wired into the QC gates until the offline evaluation supports it.
export function castListingOk(expected: { species: string; count: number }[], listing: CastListing): string | null {
  if (listing.humans_or_humanoids > 0 && !expected.some((e) => /human|person|boy|girl|child|man|woman/i.test(e.species))) {
    return `cast listing: ${listing.humans_or_humanoids} human(s) on an animal-cast page`;
  }
  if (!listing.single_scene) return "cast listing: not a single scene (pose sheet or collage)";
  if (listing.same_pose_repeated) return "cast listing: same figure drawing repeated (copied pose)";
  for (const e of expected) {
    const want = e.species.toLowerCase().trim();
    const got = listing.animals.find((a) => a.species.includes(want) || want.includes(a.species));
    if (!got) return `cast listing: expected ${e.count} x ${e.species}, species absent`;
    if (got.count !== e.count) return `cast listing: expected ${e.count} x ${e.species}, found ${got.count}`;
  }
  for (const a of listing.animals) {
    const known = expected.some((e) => {
      const want = e.species.toLowerCase().trim();
      return a.species.includes(want) || want.includes(a.species);
    });
    if (!known && a.count > 0) return `cast listing: unexpected animal ${a.count} x ${a.species}`;
  }
  return null;
}
