import { test, expect, describe } from "bun:test";
import {
  R2_PUBLIC,
  MEDIA_PUBLIC,
  keyFromMediaValue,
  mediaUrl,
  adminMediaUrl,
  libraryPageUrl,
  isSafeMediaKey,
  serveR2Object,
} from "../src/lib/media";
import { readerPageKeyAllowed } from "../src/lib/library";

// Second-door closure (2026-10-28): the bucket's public r2.dev domain
// is disabled. These tests pin the URL discipline that replaces it:
// display art on the media host, reader pages and admin media behind
// gated hub routes, and no public bucket URL emitted anywhere.

describe("keyFromMediaValue", () => {
  test("strips the retired r2.dev prefix", () => {
    expect(keyFromMediaValue(`${R2_PUBLIC}books/x/images/S1-page-0.jpg`)).toBe(
      "books/x/images/S1-page-0.jpg"
    );
  });
  test("strips the media-host prefix", () => {
    expect(keyFromMediaValue(`${MEDIA_PUBLIC}cast-gallery/mira/pose-1.png`)).toBe(
      "cast-gallery/mira/pose-1.png"
    );
  });
  test("passes bare keys through", () => {
    expect(keyFromMediaValue("books/x/cover-titled.jpg")).toBe("books/x/cover-titled.jpg");
  });
  test("refuses foreign absolute URLs", () => {
    expect(keyFromMediaValue("https://evil.example/books/x/images/S1-page-0.jpg")).toBeNull();
    expect(keyFromMediaValue("")).toBeNull();
    expect(keyFromMediaValue(null)).toBeNull();
  });
});

describe("URL builders", () => {
  test("mediaUrl puts display art on the media host", () => {
    expect(mediaUrl("books/x/cover-titled.jpg")).toBe(`${MEDIA_PUBLIC}books/x/cover-titled.jpg`);
    expect(mediaUrl(`${R2_PUBLIC}books/x/cover-titled.jpg`)).toBe(
      `${MEDIA_PUBLIC}books/x/cover-titled.jpg`
    );
  });
  test("adminMediaUrl gates any key behind the admin route", () => {
    expect(adminMediaUrl("books/x/versions.json")).toBe(
      `/api/admin/media?key=${encodeURIComponent("books/x/versions.json")}`
    );
  });
  test("libraryPageUrl gates page images behind the reader route", () => {
    expect(libraryPageUrl("x", "books/x/images/S1-page-0.jpg")).toBe(
      `/api/library/page/x?key=${encodeURIComponent("books/x/images/S1-page-0.jpg")}`
    );
  });
});

describe("isSafeMediaKey", () => {
  test("accepts ordinary keys", () => {
    expect(isSafeMediaKey("books/x/images/S1-page-0.jpg")).toBe(true);
    expect(isSafeMediaKey("characters/mira.png")).toBe(true);
  });
  test("rejects traversal and junk", () => {
    expect(isSafeMediaKey("../secret")).toBe(false);
    expect(isSafeMediaKey("books/../secret")).toBe(false);
    expect(isSafeMediaKey("/books/x.pdf")).toBe(false);
    expect(isSafeMediaKey("")).toBe(false);
    expect(isSafeMediaKey("books/x/a b.jpg")).toBe(false);
  });
});

describe("readerPageKeyAllowed", () => {
  test("allows the book's own line and color pages", () => {
    expect(readerPageKeyAllowed("x", "books/x/images/S1-page-0.jpg")).toBe(true);
    expect(readerPageKeyAllowed("x", "books/x/images/S8-finale.jpg")).toBe(true);
    expect(readerPageKeyAllowed("x", "books/x/images-color/S1-page-0.jpg")).toBe(true);
  });
  test("allows legacy root-level page files (docker shape)", () => {
    expect(readerPageKeyAllowed("docker", "docker/S1-page-0.jpg")).toBe(true);
    expect(readerPageKeyAllowed("docker", "docker/S1-page-1-r1792476913614.jpg")).toBe(true);
  });
  test("refuses other books, deliverables, and internals", () => {
    expect(readerPageKeyAllowed("x", "books/y/images/S1-page-0.jpg")).toBe(false);
    expect(readerPageKeyAllowed("x", "books/x/picture-book.pdf")).toBe(false);
    expect(readerPageKeyAllowed("x", "books/x/book.epub")).toBe(false);
    expect(readerPageKeyAllowed("x", "books/x/audiobook.m4b")).toBe(false);
    expect(readerPageKeyAllowed("x", "books/x/editor_chapters.json")).toBe(false);
    expect(readerPageKeyAllowed("x", "books/x/bible.json")).toBe(false);
    expect(readerPageKeyAllowed("x", "characters/mira.png")).toBe(false);
    expect(readerPageKeyAllowed("x", "books/x/images/../../characters/mira.png")).toBe(false);
  });
});

// ---- serveR2Object against a fake binding -------------------------------

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const fakeBooks = {
  async head(key: string) {
    if (key !== "books/x/images/S1-page-0.jpg") return null;
    return { size: BYTES.length, httpMetadata: { contentType: "image/jpeg" } };
  },
  async get(key: string, opts?: any) {
    if (key !== "books/x/images/S1-page-0.jpg") return null;
    if (opts?.range) {
      const { offset, length } = opts.range;
      return { body: BYTES.subarray(offset, offset + length) };
    }
    return { body: BYTES };
  },
};

describe("serveR2Object", () => {
  test("full GET streams 200 with content length", async () => {
    const res = await serveR2Object({
      books: fakeBooks, key: "books/x/images/S1-page-0.jpg",
      method: "GET", rangeHeader: null,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });
  test("HEAD answers headers only", async () => {
    const res = await serveR2Object({
      books: fakeBooks, key: "books/x/images/S1-page-0.jpg",
      method: "HEAD", rangeHeader: null,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await res.arrayBuffer()).toHaveLength(0);
  });
  test("satisfiable Range answers 206 with the exact slice", async () => {
    const res = await serveR2Object({
      books: fakeBooks, key: "books/x/images/S1-page-0.jpg",
      method: "GET", rangeHeader: "bytes=2-5",
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.subarray(2, 6));
  });
  test("unsatisfiable Range answers 416", async () => {
    const res = await serveR2Object({
      books: fakeBooks, key: "books/x/images/S1-page-0.jpg",
      method: "GET", rangeHeader: "bytes=50-60",
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
  });
  test("missing object answers 404", async () => {
    const res = await serveR2Object({
      books: fakeBooks, key: "books/x/images/nope.jpg",
      method: "GET", rangeHeader: null,
    });
    expect(res.status).toBe(404);
  });
});

// ---- route wiring (source-level, the repo's pattern for pages) ----------

describe("gated route wiring", () => {
  test("reader page route self-auths and checks digital ownership", async () => {
    const src = await Bun.file(
      new URL("../src/pages/api/library/page/[slug].ts", import.meta.url)
    ).text();
    expect(src.includes("getSession")).toBe(true);
    expect(src.includes("ownsDigitalBook")).toBe(true);
    expect(src.includes("readerPageKeyAllowed")).toBe(true);
    expect(src.includes("401")).toBe(true);
    expect(src.includes("403")).toBe(true);
  });
  test("admin media route requires the admin user", async () => {
    const src = await Bun.file(
      new URL("../src/pages/api/admin/media.ts", import.meta.url)
    ).text();
    expect(src.includes("locals")).toBe(true);
    expect(src.includes("isSafeMediaKey")).toBe(true);
  });
  test("character-art sheet route is admin-gated at middleware and route level", async () => {
    const mw = await Bun.file(new URL("../src/middleware.ts", import.meta.url)).text();
    // No public pass remains: anonymous requests fall to the standard
    // /api/* rule and get the gate's 401.
    expect(mw.includes('pathname === "/api/character-art"')).toBe(false);
    const src = await Bun.file(
      new URL("../src/pages/api/character-art.ts", import.meta.url)
    ).text();
    // Route-level defense in depth, same shape as /api/admin/character-sheet.
    expect(src.includes("locals")).toBe(true);
    expect(src.includes("401")).toBe(true);
    // Approved-sheet logic intact for admin requests.
    expect(src.includes("resolveCharacterSheets")).toBe(true);
    expect(src.includes("picture_book_key IS NOT NULL")).toBe(true);
    // Authenticated bytes are never publicly cacheable.
    expect(src.includes("private, no-store")).toBe(true);
    expect(src.includes("public, max-age=86400")).toBe(false);
  });
  test("middleware lets the self-authenticating reader page route through", async () => {
    const src = await Bun.file(new URL("../src/middleware.ts", import.meta.url)).text();
    expect(src.includes('pathname.startsWith("/api/library/page/")')).toBe(true);
  });
  test("lift worker route serves bytes by key and hands out no public URLs", async () => {
    const src = await Bun.file(
      new URL("../src/pages/api/lift/worker.ts", import.meta.url)
    ).text();
    expect(src.includes('"asset"')).toBe(true);
    expect(src.includes("(characters|cast-gallery)")).toBe(true);
    expect(src.includes("sheetUrl")).toBe(false);
    expect(src.includes("poseUrl")).toBe(false);
    expect(src.includes("pub-5e76")).toBe(false);
  });
});
