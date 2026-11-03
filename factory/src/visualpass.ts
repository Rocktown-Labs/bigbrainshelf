// ------------------------------------------------------- whole-book visual pass
//
// Before colorize spends a cent painting a book, the whole book's LINE
// art gets one deterministic pass (merged factory-scale plan, step 7):
// every planned page's line image must exist and pass the same purity
// verdicts the line gates applied page by page. Defects park the
// colorize at needs_visual_review instead of discovering a broken line
// page halfway through paid color rolls (the Mira S3p0 hand-feet page
// was found by census AFTER colorize money was spent). Deterministic
// only: no model calls, no spend. The report lands at
// books/{slug}/visualpass.json and as a production event.

import { analyzePage, pageVerdict } from "./purity";
import { r2GetJson, r2ListAll } from "./bookbuild";
import { emitEvent } from "./events";

export interface VisualDefect {
  chapter: string;
  page: number; // -1 = chapter finale
  issue: string;
}

export async function runVisualPass(env: any, slug: string): Promise<{ ok: boolean; checked: number; defects: VisualDefect[] }> {
  const defects: VisualDefect[] = [];
  let checked = 0;
  const planKeys = (await r2ListAll(env.BOOKS, `books/${slug}/plans/`))
    .filter((k: string) => /\/plans\/S\d+\.json$/.test(k))
    .sort();
  for (const pk of planKeys) {
    const ch = pk.match(/\/(S\d+)\.json$/)![1];
    const plan: any = await r2GetJson(env.BOOKS, pk);
    if (!plan?.pages) continue;
    const targets: { page: number; key: string; held?: boolean }[] = plan.pages.map((p: any, i: number) => ({
      page: i,
      key: `books/${slug}/images/${ch}-page-${i}.jpg`,
      held: !!p?.held,
    }));
    if (plan.finale) {
      targets.push({ page: -1, key: `books/${slug}/images/${ch}-finale.jpg`, held: !!plan.finale?.held });
    }
    for (const t of targets) {
      checked++;
      if (t.held) {
        defects.push({ chapter: ch, page: t.page, issue: "page is held in production (gates never passed it)" });
        continue;
      }
      const obj = await env.BOOKS.get(t.key);
      if (!obj) {
        defects.push({ chapter: ch, page: t.page, issue: `line image missing: ${t.key}` });
        continue;
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const v = pageVerdict(analyzePage(bytes));
      if (v.verdict === "reject") {
        defects.push({ chapter: ch, page: t.page, issue: `purity: ${v.reasons.join("; ")}` });
      }
    }
  }
  const report = { slug, at: Math.floor(Date.now() / 1000), checked, defects };
  try {
    await env.BOOKS.put(`books/${slug}/visualpass.json`, JSON.stringify(report, null, 1), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch { /* report is also returned + evented */ }
  await emitEvent(env, {
    slug,
    kind: "visualpass",
    event: defects.length ? "visual_pass_defects" : "visual_pass_clean",
    detail: { checked, defects: defects.slice(0, 50) },
  });
  return { ok: defects.length === 0, checked, defects };
}
