// bbs-media: hotlink-guarded display-image host for Big Brain Shelf.
//
// Serves ONLY the public display surface (cast gallery art + book
// covers and their WebP derivatives) from the kidsbook-factory R2
// bucket. Full-res originals also live on the public r2.dev host;
// this worker guards the URLs the public pages actually render.
//
// Referer policy:
//   - no Referer (direct navigation, most crawlers)  -> real image
//   - Referer on bigbrainshelf.com / this host       -> real image
//   - known social crawler UA (FB/Twitter/etc.)      -> real image
//   - any other Referer (foreign embed / hotlink)    -> deterrent card
// The deterrent is deterrent/just-buy-it.png in the bucket (source:
// kidsbook-hub/public/just-buy-it.png, "JUST BUY IT / bigbrainshelf.com").
//
// Bulk scrapers that send no Referer are indistinguishable from direct
// browser navigation and social crawlers, so they are NOT blocked
// here; that layer is rate limiting, not referer policy.
//
// Cache policy (changed 2026-11-03, cover propagation fix): only the
// resized WebP derivatives (keys ending -w<width>.webp) are served
// immutable for a year. Derivative URLs are content-versioned by the
// hub (byte-size ?v= tokens), so a regenerated derivative gets a new
// URL and the immutable copy at the old URL is harmless. ORIGINALS
// (cover-titled.jpg, portrait.png, pose-N.png, ...) are served with a
// short max-age instead: their URLs are stable across replacements,
// and the old default pinned whatever bytes a URL first served for a
// year (Blaze's replaced cover kept serving the retired BASIL art
// from cache long after R2 held the new cover). A replaced original
// now propagates everywhere within minutes.
//
// This repo copy is the canonical source for the bbs-media worker as
// of 2026-11-03; the VM working copy under
// ~/workspace/factory-ops/image-derivatives/ is a deploy staging copy.
// Deploy with deploy_media.py from that folder after updating it from
// this source.

const DETERRENT_KEY = "deterrent/just-buy-it.png";
const ALLOWED_HOSTS = new Set([
  "bigbrainshelf.com",
  "www.bigbrainshelf.com",
  "media.bigbrainshelf.com",
  "localhost",
  "127.0.0.1",
]);
const CRAWLER_UA = /(facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|discordbot|whatsapp|linkedinbot|pinterestbot|telegrambot|redditbot|embedly|quora link preview|skypeuripreview|vkshare|bingbot|googlebot)/i;
const ALLOWED_KEY = /^(cast-gallery\/.+\.(png|webp|jpe?g)|books\/[^/]+\/cover[^/]*\.(png|webp|jpe?g))$/;
// Derivative twins carry their pixel width in the name
// (cover-w400.webp, portrait-w560.webp, pose-1-w640.webp); everything
// else this host serves is an original at a stable URL.
const DERIVATIVE_KEY = /-w\d+\.webp$/;
const IMMUTABLE_CC = "public, max-age=31536000, immutable";
const ORIGINAL_CC = "public, max-age=300";

function applyCachePolicy(key, headers) {
  if (DERIVATIVE_KEY.test(key)) {
    if (!headers.has("Cache-Control")) headers.set("Cache-Control", IMMUTABLE_CC);
  } else {
    // Deliberately overrides any Cache-Control stored on the object:
    // a replaced original must not be pinnable by stale metadata.
    headers.set("Cache-Control", ORIGINAL_CC);
  }
}

let deterrentCache = null;

async function deterrent(env) {
  if (!deterrentCache) {
    const obj = await env.BOOKS.get(DETERRENT_KEY);
    if (!obj) return new Response("not found", { status: 404 });
    deterrentCache = await obj.arrayBuffer();
  }
  return new Response(deterrentCache, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-BBS-Image": "deterrent-hotlink",
    },
  });
}

function refererClass(req) {
  const ua = req.headers.get("user-agent") || "";
  if (CRAWLER_UA.test(ua)) return "own";
  const ref = req.headers.get("referer");
  if (!ref) return "own";
  try {
    const host = new URL(ref).hostname.toLowerCase();
    return ALLOWED_HOSTS.has(host) ? "own" : "foreign";
  } catch {
    return "foreign";
  }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!ALLOWED_KEY.test(key)) return new Response("not found", { status: 404 });

    const cls = refererClass(req);

    // Edge-cache per referer class so a foreign embed can never poison
    // the on-site copy of the same URL (and vice versa).
    const cache = caches.default;
    const cacheKey = new Request(
      `https://media.bigbrainshelf.com/${key}?_rc=${cls}${url.search ? "&" + url.search.slice(1) : ""}`,
      { method: "GET" }
    );
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let res;
    if (cls === "foreign") {
      res = await deterrent(env);
    } else if (req.method === "HEAD") {
      const head = await env.BOOKS.head(key);
      if (!head) return new Response("not found", { status: 404 });
      const headers = new Headers();
      head.writeHttpMetadata(headers);
      headers.set("ETag", head.httpEtag);
      headers.set("Accept-Ranges", "bytes");
      applyCachePolicy(key, headers);
      res = new Response(null, { status: 200, headers });
      return res; // HEAD responses are not cached
    } else {
      const range = req.headers.get("range");
      const obj = range
        ? await env.BOOKS.get(key, { range: req.headers })
        : await env.BOOKS.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("ETag", obj.httpEtag);
      headers.set("Accept-Ranges", "bytes");
      applyCachePolicy(key, headers);
      let status = 200;
      if (range && obj.range) {
        const off = obj.range.offset || 0;
        const len = obj.range.length != null ? obj.range.length : obj.size - off;
        headers.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`);
        headers.set("Content-Length", String(len));
        status = 206;
      }
      res = new Response(obj.body, { status, headers });
    }
    if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
