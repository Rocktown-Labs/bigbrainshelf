// Pillar 2: Book-to-YouTube Automated HyperFrames Composition & Storyboard Pipeline
//
// Compiles any finished book in D1 (`books`, `chapters`, `characters`, `cast-gallery`)
// into a deterministic HyperFrames HTML composition (`data-composition-id="main"`,
// `class="clip"`, `data-start`, `data-duration`, `data-track`, seek-safe GSAP timeline)
// for both 16:9 YouTube Episodes (1920x1080) and 9:16 YouTube Shorts (1080x1920).

import type { DBLike } from "./orders";
import { ensureOnce } from "./schema-cache";
import { retrieveCanonContinuity, recordGenerationCost } from "./braintrust";

export type VideoAspectFormat = "16:9" | "9:16";

export interface HyperFramesSceneClip {
  clipId: string;
  chapterNum: number;
  chapterTitle: string;
  pageNumber: number;
  startSec: number;
  durationSec: number;
  narrationText: string;
  illustrationUrl: string;
  characterCutoutUrls: string[];
  audioTrackUrl: string | null;
  cameraMove: "ken-burns-in" | "ken-burns-pan-right" | "ken-burns-out" | "gentle-float";
}

export interface HyperFramesCompositionBundle {
  bookSlug: string;
  bookTitle: string;
  aspect: VideoAspectFormat;
  width: number;
  height: number;
  fps: number;
  totalDurationSec: number;
  scenes: HyperFramesSceneClip[];
  canonContinuityNote: string;
  html: string;
  manifestKey: string;
  htmlKey: string;
}

export async function ensureVideoJobsTable(db: DBLike): Promise<void> {
  await ensureOnce(db, "video_jobs_v2", async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS video_jobs (
          id TEXT PRIMARY KEY,
          book_slug TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          detail TEXT,
          video_key TEXT,
          aspect TEXT DEFAULT '16:9',
          engine TEXT DEFAULT 'hyperframes',
          composition_key TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`
      )
      .run();
    for (const [col, type] of [
      ["aspect", "TEXT DEFAULT '16:9'"],
      ["engine", "TEXT DEFAULT 'hyperframes'"],
      ["composition_key", "TEXT"],
    ] as const) {
      try {
        await db.prepare(`ALTER TABLE video_jobs ADD COLUMN ${col} ${type}`).run();
      } catch {}
    }
  });
}

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CAMERA_MOVES: HyperFramesSceneClip["cameraMove"][] = [
  "ken-burns-in",
  "ken-burns-pan-right",
  "ken-burns-out",
  "gentle-float",
];

// Build a deterministic HyperFrames composition (`index.html` + structured scene manifest)
// from a book's chapters, illustrations, character cutouts, and audio tracks.
export async function buildHyperFramesComposition(
  db: DBLike,
  env: any,
  bookSlug: string,
  opts: { aspect?: VideoAspectFormat; maxScenes?: number } = {}
): Promise<HyperFramesCompositionBundle> {
  await ensureVideoJobsTable(db);
  const aspect: VideoAspectFormat = opts.aspect === "9:16" ? "9:16" : "16:9";
  const width = aspect === "9:16" ? 1080 : 1920;
  const height = aspect === "9:16" ? 1920 : 1080;
  const fps = 30;

  const book: any = await db
    .prepare("SELECT slug, title, topic, cover_key, audiobook_key, public_slug FROM books WHERE slug = ?")
    .bind(bookSlug)
    .first()
    .catch(() =>
      db.prepare("SELECT slug, title, topic, cover_key, audiobook_key FROM books WHERE slug = ?").bind(bookSlug).first()
    );

  const bookTitle = String(book?.title || bookSlug);
  const canon = await retrieveCanonContinuity(db, env, `${bookTitle} ${book?.topic || ""}`, bookSlug);

  let chapters: any[] = [];
  try {
    const chRes = await db
      .prepare("SELECT num, title, content, pages, real_concept FROM chapters WHERE book_slug = ? ORDER BY num ASC")
      .bind(bookSlug)
      .all()
      .catch(() =>
        db.prepare("SELECT num, title FROM chapters WHERE book_slug = ? ORDER BY num ASC").bind(bookSlug).all()
      );
    chapters = (chRes.results || (chRes as any).rows || []) as any[];
  } catch {}

  let characters: any[] = [];
  try {
    const cRes = await db
      .prepare("SELECT id, name, species FROM characters WHERE book_slug = ?")
      .bind(bookSlug)
      .all();
    characters = (cRes.results || (cRes as any).rows || []) as any[];
  } catch {}

  const cutoutUrls = characters.slice(0, 3).map((c, idx) => {
    const cSlug = String(c.name || c.id || `char-${idx}`).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `/api/character-art?slug=${encodeURIComponent(cSlug)}&pose=1`;
  });

  const scenes: HyperFramesSceneClip[] = [];
  let cursorSec = 0;

  // Title Card Scene (3.5s)
  scenes.push({
    clipId: "scene-title-card",
    chapterNum: 0,
    chapterTitle: bookTitle,
    pageNumber: 0,
    startSec: 0,
    durationSec: 3.5,
    narrationText: `${bookTitle} · A Big Brain Shelf Read-Along Story`,
    illustrationUrl: book?.cover_key ? `/api/library/page/${encodeURIComponent(bookSlug)}?key=${encodeURIComponent(book.cover_key)}` : `/icon-512.png`,
    characterCutoutUrls: cutoutUrls,
    audioTrackUrl: `/api/audio-sample/${encodeURIComponent(bookSlug)}/intro`,
    cameraMove: "ken-burns-in",
  });
  cursorSec += 3.5;

  const maxScenes = opts.maxScenes ?? (aspect === "9:16" ? 6 : 16);
  if (chapters.length === 0) {
    // Fallback single chapter scene if chapters table isn't populated yet
    scenes.push({
      clipId: "scene-ch-1-p-1",
      chapterNum: 1,
      chapterTitle: "Chapter 1",
      pageNumber: 1,
      startSec: cursorSec,
      durationSec: 8,
      narrationText: `Join our characters in ${bookTitle} as they discover ${book?.topic || "a new big idea"}!`,
      illustrationUrl: `/api/sample/${encodeURIComponent(bookSlug)}/1`,
      characterCutoutUrls: cutoutUrls,
      audioTrackUrl: `/api/audio-sample/${encodeURIComponent(bookSlug)}/ch1`,
      cameraMove: "ken-burns-pan-right",
    });
    cursorSec += 8;
  } else {
    for (const ch of chapters) {
      if (scenes.length >= maxScenes) break;
      const chNum = Number(ch.num || 1);
      const chTitle = String(ch.title || `Chapter ${chNum}`);
      let pageTexts: string[] = [];
      if (ch.pages) {
        try {
          const parsed = JSON.parse(ch.pages);
          if (Array.isArray(parsed)) {
            pageTexts = parsed.map((p: any) => String(p?.text || p?.caption || p || "").trim()).filter(Boolean);
          }
        } catch {}
      }
      if (pageTexts.length === 0 && ch.content) {
        pageTexts = String(ch.content)
          .split(/\n\n+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 2);
      }
      if (pageTexts.length === 0) {
        pageTexts = [`Chapter ${chNum}: ${chTitle}.`];
      }

      for (let pi = 0; pi < pageTexts.length; pi++) {
        if (scenes.length >= maxScenes) break;
        const text = pageTexts[pi];
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        const durationSec = Math.max(5, Math.min(14, Number((wordCount / 2.4).toFixed(1))));
        const move = CAMERA_MOVES[scenes.length % CAMERA_MOVES.length];

        scenes.push({
          clipId: `scene-ch-${chNum}-p-${pi + 1}`,
          chapterNum: chNum,
          chapterTitle: chTitle,
          pageNumber: pi + 1,
          startSec: Number(cursorSec.toFixed(2)),
          durationSec,
          narrationText: text,
          illustrationUrl: `/api/sample/${encodeURIComponent(bookSlug)}/${scenes.length}`,
          characterCutoutUrls: cutoutUrls,
          audioTrackUrl: pi === 0 ? `/api/audio-sample/${encodeURIComponent(bookSlug)}/ch${chNum}` : null,
          cameraMove: move,
        });
        cursorSec = Number((cursorSec + durationSec).toFixed(2));
      }
    }
  }

  // Outro CTA Scene (4s) — YouTube → Storefront / Book Club Funnel
  scenes.push({
    clipId: "scene-outro-cta",
    chapterNum: 99,
    chapterTitle: "Read & Color Along at BigBrainShelf.com",
    pageNumber: 99,
    startSec: cursorSec,
    durationSec: 4,
    narrationText: `Get the full-color book, printable coloring pack, and Read-Along audiobook at BigBrainShelf.com!`,
    illustrationUrl: `/icon-512.png`,
    characterCutoutUrls: cutoutUrls,
    audioTrackUrl: null,
    cameraMove: "gentle-float",
  });
  cursorSec = Number((cursorSec + 4).toFixed(2));

  const clipMarkup = scenes
    .map(
      (s) => `
    <!-- Scene: ${escapeHtml(s.clipId)} -->
    <div id="${escapeHtml(s.clipId)}"
         class="clip scene-clip"
         data-start="${s.startSec}"
         data-duration="${s.durationSec}"
         data-track="visual-scenes"
         data-camera="${s.cameraMove}">
      <div class="scene-bg-layer">
        <img src="${escapeHtml(s.illustrationUrl)}" alt="${escapeHtml(s.chapterTitle)}" class="scene-illustration" />
      </div>
      <div class="scene-caption-safezone">
        <div class="chapter-pill">${escapeHtml(s.chapterTitle)}</div>
        <p class="read-along-caption">${escapeHtml(s.narrationText)}</p>
      </div>
    </div>`
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(bookTitle)} — HyperFrames Read-Along (${aspect})</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #1a3454; font-family: 'Nunito', system-ui, sans-serif; }
    #stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: radial-gradient(circle at 50% 35%, #244770, #112238); }
    .scene-clip { position: absolute; inset: 0; width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; }
    .scene-bg-layer { position: absolute; inset: 0; overflow: hidden; }
    .scene-illustration { width: 100%; height: 100%; object-fit: cover; transform-origin: center center; }
    .scene-caption-safezone {
      position: relative;
      z-index: 10;
      margin: ${aspect === "9:16" ? "0 64px 180px 64px" : "0 120px 72px 120px"};
      padding: 28px 36px;
      border-radius: 28px;
      background: rgba(17, 34, 56, 0.88);
      border: 2px solid rgba(251, 146, 60, 0.55);
      color: #ffffff;
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.45);
    }
    .chapter-pill {
      display: inline-block;
      font-size: 20px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #fdba74;
      margin-bottom: 10px;
    }
    .read-along-caption {
      font-size: ${aspect === "9:16" ? "38px" : "34px"};
      line-height: 1.38;
      font-weight: 700;
      color: #fffbeb;
    }
  </style>
</head>
<body>
  <!-- HyperFrames Composition Root -->
  <div id="stage"
       data-composition-id="main"
       data-width="${width}"
       data-height="${height}"
       data-fps="${fps}"
       data-duration="${cursorSec}">
${clipMarkup}
  </div>
  <script>
    // Deterministic seek-safe HyperFrames timeline adapter
    window.__hyperframesSeek = function(timeSec) {
      var clips = document.querySelectorAll('.scene-clip');
      for (var i = 0; i < clips.length; i++) {
        var el = clips[i];
        var start = parseFloat(el.getAttribute('data-start') || '0');
        var dur = parseFloat(el.getAttribute('data-duration') || '5');
        var active = timeSec >= start && timeSec < (start + dur);
        el.style.display = active ? 'flex' : 'none';
        if (active) {
          var p = Math.max(0, Math.min(1, (timeSec - start) / Math.max(0.1, dur)));
          var img = el.querySelector('.scene-illustration');
          var move = el.getAttribute('data-camera');
          if (img) {
            var scale = move === 'ken-burns-out' ? (1.12 - p * 0.1) : (1.0 + p * 0.1);
            var tx = move === 'ken-burns-pan-right' ? (-20 + p * 40) : 0;
            img.style.transform = 'scale(' + scale.toFixed(4) + ') translateX(' + tx.toFixed(1) + 'px)';
          }
        }
      }
    };
    window.__hyperframesSeek(0);
  </script>
</body>
</html>`;

  const htmlKey = `videos/${bookSlug}/hyperframes/${aspect === "9:16" ? "short" : "episode"}/index.html`;
  const manifestKey = `videos/${bookSlug}/hyperframes/${aspect === "9:16" ? "short" : "episode"}/manifest.json`;

  const bundle: HyperFramesCompositionBundle = {
    bookSlug,
    bookTitle,
    aspect,
    width,
    height,
    fps,
    totalDurationSec: cursorSec,
    scenes,
    canonContinuityNote: canon.continuityPromptBlock,
    html,
    manifestKey,
    htmlKey,
  };

  // Persist composition artifacts to R2 if BOOKS bucket is bound
  if (env?.BOOKS && typeof env.BOOKS.put === "function") {
    try {
      await env.BOOKS.put(htmlKey, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
      await env.BOOKS.put(manifestKey, JSON.stringify(bundle, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch {}
  }

  // Record COGS in ledger (HyperFrames composition build)
  try {
    await recordGenerationCost(db, {
      book_slug: bookSlug,
      gateway: "hyperframes",
      stage: "video_hyperframes",
      model: `hyperframes-${aspect}`,
      units: scenes.length,
      cost_cents: scenes.length * 2, // ~$0.02 per rendered scene container compute estimate
      metadata: { aspect, totalDurationSec: cursorSec, scenes: scenes.length },
    });
  } catch {}

  return bundle;
}
