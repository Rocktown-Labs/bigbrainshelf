// Sectioned search tests: matching (prefix/substring/token AND),
// ranking, section order and limits, the uniform item shape, the
// natural-language layer (stopwords + concept clusters), the
// own-book cast boost, and the protagonist tiebreak.
// Runs the pure core in src/lib/search.ts. Run with: bun tests/search.test.ts
import {
  searchCatalog,
  bookCandidate,
  audioCandidate,
  castCandidate,
  tokenize,
  queryTokenGroups,
  SECTION_LIMITS,
  type SearchCandidate,
} from "../src/lib/search";

let failures = 0;
function assert(cond: any, label: string) {
  if (cond) console.log("PASS:", label);
  else { failures += 1; console.error("FAIL:", label); }
}

const miraBook = { slug: "mastery", title: "Mira the Heron and the Still Water", topic: "courage", topics: "mastery,patience", cover_key: "covers/mastery.jpg", audiobook_key: "books/mastery/audiobook.m4b", description: "A heron learns to wait." };
const wallyBook = { slug: "docker", title: "Wally the Whale and the Harbor Bins", topic: "tech", topics: "docker,containers", cover_key: "covers/docker.jpg", audiobook_key: null, description: "A whale runs a harbor." };
const castTerms = ["Mira heron", "Ansel heron", "The Otter river otter"];
const concepts = ["mastery", "deliberate practice"];

const catalog = {
  books: [
    bookCandidate(miraBook, "Mira", castTerms, concepts),
    bookCandidate(wallyBook, "Wally", ["Wally whale", "Skipper crab"], ["containers"]),
  ],
  cast: [
    castCandidate({ slug: "mira", name: "Mira", species: "heron", role: "The Learner", bookSlug: "mastery", bookTitle: miraBook.title, topic: "Courage", portrait: "https://x/mira.png" }, { lead: true }),
    castCandidate({ slug: "the-otter", name: "The Otter", species: "river otter", role: "The Shortcut", bookSlug: "mastery", bookTitle: miraBook.title, topic: "Courage", portrait: "https://x/otter.png" }),
    castCandidate({ slug: "tamira", name: "Tamira", species: "turtle", role: "The Slow One", bookSlug: "docker", bookTitle: wallyBook.title, topic: "Tech", portrait: null }),
  ],
  audio: [audioCandidate(miraBook, "Mira", castTerms, concepts)],
};

// "mira" lands in all three live sections, in CG's order.
{
  const sections = searchCatalog(catalog, "mira");
  assert(sections.map((s) => s.type).join(",") === "books,cast,audio", "mira: sections ordered books, cast, audio");
  assert(sections[0].items[0].href === "/books/mastery", "mira: book item href");
  assert(sections[1].items[0].title === "Mira", "mira: cast item is Mira");
  assert(sections[1].items[0].href === "/meet-the-cast/mira", "mira: cast href");
  assert(sections[2].items[0].meta.format === "audiobook", "mira: audio item marked as the audiobook");
  assert(sections[2].items[0].href === "/books/mastery?format=audio", "mira: audio item links to the book page with the audio format preselected");
  const item = sections[0].items[0];
  assert(["type", "title", "subtitle", "imageUrl", "href", "meta"].every((k) => k in item), "items carry the uniform shape");
}

// Prefix beats substring, and the book's own cast beats both: for
// "mira" the order is Mira (name), The Otter (her bookmate, lifted
// by the own-book boost), then Tamira (an incidental substring hit
// from another book).
{
  const cast = searchCatalog(catalog, "mira").find((s) => s.type === "cast")!;
  assert(
    cast.items.map((i) => i.title).join(",") === "Mira,The Otter,Tamira",
    "mira cast order: name match, own-book cast, incidental substring"
  );
}

// "otter" finds the Otter in Cast.
{
  const sections = searchCatalog(catalog, "otter");
  const cast = sections.find((s) => s.type === "cast");
  assert(!!cast && cast.items.some((i) => i.title === "The Otter"), "otter: found in Cast");
}

// Token AND semantics: "mira heron" matches, "mira zebra" does not.
{
  assert(searchCatalog(catalog, "mira heron").length > 0, "multi-token: all tokens hit");
  assert(searchCatalog(catalog, "mira zebra").length === 0, "multi-token: one missing token excludes");
}

// Case and punctuation do not matter.
{
  assert(searchCatalog(catalog, "  MIRA! ").length === 3, "query normalization: case and punctuation");
  assert(tokenize("Still-Water,  please").join("|") === "still|water|please", "tokenize splits on punctuation");
}

// Nonsense and empty queries return no sections, never an error shape.
{
  assert(Array.isArray(searchCatalog(catalog, "zzzzqqq")) && searchCatalog(catalog, "zzzzqqq").length === 0, "nonsense query: empty sections");
  assert(searchCatalog(catalog, "").length === 0, "empty query: empty sections");
  assert(searchCatalog(catalog, "   ").length === 0, "blank query: empty sections");
}

// A book without an audiobook never appears in Audio; "audiobook" as a
// word finds the audio section.
{
  const sections = searchCatalog(catalog, "audiobook");
  const audio = sections.find((s) => s.type === "audio");
  assert(!!audio && audio.items.length === 1 && audio.items[0].meta.slug === "mastery", "audiobook: only books with audiobooks appear");
}

// Section limits hold.
{
  const many: SearchCandidate[] = [];
  for (let i = 0; i < 12; i++) {
    many.push(bookCandidate({ slug: "b" + i, title: "Test Book " + i, topic: "tech", topics: "test", cover_key: null, audiobook_key: null }, null, [], []));
  }
  const sections = searchCatalog({ books: many }, "test");
  assert(sections[0].items.length === SECTION_LIMITS.books, "books section capped at its limit");
}

// Video is a defined section: empty by default, renders (last) when a
// source feeds it candidates.
{
  assert(!searchCatalog(catalog, "mira").some((s) => s.type === "video"), "video: absent with no source");
  const withVideo = {
    ...catalog,
    video: [{ item: { type: "video" as const, title: "Mira reads chapter one", subtitle: "Video", imageUrl: null, href: "/videos/mira", meta: {} }, fields: [{ text: "Mira", weight: 3 }] }],
  };
  const types = searchCatalog(withVideo, "mira").map((s) => s.type);
  assert(types[types.length - 1] === "video", "video: appears last when a source exists");
}

// ---- Natural-language layer -------------------------------------

const pennyBook = { slug: "richdadpoordad", title: "Penny the Squirrel and the Acorn Orchard", topic: "money", topics: "saving,investing,money-habits", cover_key: "covers/richdadpoordad.jpg", audiobook_key: null, description: "" };
const maisieBook = { slug: "compoundeffect", title: "Maisie the Mouse and the Jar That Grew", topic: "money", topics: "compounding,habits,choices", cover_key: null, audiobook_key: null, description: "" };
const wrenBook = { slug: "thewarofart", title: "Wren the Songbird and the Gray Fog", topic: "courage", topics: "resistance,habits,showing-up", cover_key: null, audiobook_key: null, description: "A songbird learns to sing." };
const moneyCatalog = {
  books: [
    bookCandidate(pennyBook, "Penny", ["Penny squirrel", "Bram badger", "Hazel squirrel"], ["Money is not the acorns you eat. It is the trees you plant.", "assets"]),
    bookCandidate(maisieBook, "Maisie", ["Maisie mouse", "Jasper fox"], ["Tiny choices, repeated daily, grow over time"]),
    bookCandidate(wallyBook, "Wally", ["Wally whale", "Skipper crab"], ["containers"]),
    bookCandidate(wrenBook, "Wren", ["Wren songbird"], ["Resistance", "Courage"]),
    bookCandidate(miraBook, "Mira", castTerms, concepts),
  ],
  cast: [
    castCandidate({ slug: "penny", name: "Penny", species: "squirrel", role: "The Saver", bookSlug: "richdadpoordad", bookTitle: pennyBook.title, topic: "Money", portrait: null }, { lead: true }),
    castCandidate({ slug: "bram", name: "Bram", species: "badger", role: "The Keeper", bookSlug: "richdadpoordad", bookTitle: pennyBook.title, topic: "Money", portrait: null }),
    castCandidate({ slug: "maisie", name: "Maisie", species: "mouse", role: "The Patient One", bookSlug: "compoundeffect", bookTitle: maisieBook.title, topic: "Money", portrait: null }, { lead: true }),
  ],
};

// Stopwords are stripped at the group stage, not by tokenize.
{
  const groups = queryTokenGroups("book about money");
  assert(groups.length === 1 && groups[0][0] === "money", "groups: filler dropped, money survives as the typed token");
  assert(groups[0].includes("saving") && groups[0].includes("investing"), "groups: money expands to its catalog cluster");
  assert(queryTokenGroups("the book").length === 0, "groups: an all-stopword query has nothing to search");
  assert(searchCatalog(moneyCatalog, "the book").length === 0, "all-stopword query returns no sections");
}

// "book about money": the Money books lead, Penny ahead of Maisie
// (both carry the Money label; Penny's topics and big idea say money
// too, so the field-hit tiebreak puts her first). Filler-heavy
// phrasings land in the same place.
{
  for (const q of ["book about money", "money", "find me a story about money"]) {
    const sections = searchCatalog(moneyCatalog, q);
    const books = sections.find((s) => s.type === "books")!;
    assert(!!books && books.items[0].meta.slug === "richdadpoordad", q + ": Penny's book first");
    assert(books.items[1].meta.slug === "compoundeffect", q + ": Maisie's book second");
    assert(!books.items.some((i) => i.meta.slug === "docker"), q + ": the tech book stays out");
    // Cluster hygiene (live-data regressions): "habits" is a topics
    // word on Wren's Courage book and "earn" substring-matches
    // "learns" in Mira's and Wren's copy; neither may pull a
    // non-Money book into a money query.
    assert(books.items.length === 2, q + ": exactly the two Money books match");
  }
  const cast = searchCatalog(moneyCatalog, "book about money").find((s) => s.type === "cast")!;
  assert(!!cast && cast.items[0].title === "Penny", "book about money: Penny leads the cast row");
}

// Cluster words find their shelf even when the shelf word is absent:
// "saving" is a topics word on Penny's book; "brave" reaches the
// Courage shelf through its cluster (mastery / practice / courage).
{
  const books = searchCatalog(moneyCatalog, "saving").find((s) => s.type === "books")!;
  assert(books.items[0].meta.slug === "richdadpoordad", "saving: Penny's book first via topics");
  const courage = searchCatalog(catalog, "brave").find((s) => s.type === "books")!;
  assert(!!courage && courage.items[0].meta.slug === "mastery", "brave: the Courage book via cluster expansion");
}

// Filler words no longer poison AND matching on name queries either.
{
  assert(searchCatalog(catalog, "a book about mira").map((s) => s.type).join(",") === "books,cast,audio", "a book about mira: same sections as mira");
}

// ---- Cast boost + lead tiebreak ----------------------------------

// Without the boost, Heronia (name prefix, 240) would beat Ansel
// (species exact, 200). Ansel's book matches "heron" and Heronia's
// does not, so the own-book boost flips them: a book's own cast
// outranks an incidental name hit from another book.
{
  const flip = {
    books: [
      bookCandidate(miraBook, "Mira", castTerms, concepts),
      bookCandidate(wallyBook, "Wally", ["Wally whale", "Skipper crab"], ["containers"]),
    ],
    cast: [
      castCandidate({ slug: "ansel", name: "Ansel", species: "heron", role: "The Guide", bookSlug: "mastery", bookTitle: miraBook.title, topic: "Courage", portrait: null }),
      castCandidate({ slug: "heronia", name: "Heronia", species: "egret", role: "The Visitor", bookSlug: "docker", bookTitle: wallyBook.title, topic: "Tech", portrait: null }),
    ],
  };
  const cast = searchCatalog(flip, "heron").find((s) => s.type === "cast")!;
  assert(cast.items[0].title === "Ansel" && cast.items[1].title === "Heronia", "cast boost: the matched book's own cast outranks an incidental hit");
}

// A title-word query ties a book's whole cast on the book-title
// field; the protagonist wins the tie (Mira before Ansel, against
// alphabetical order).
{
  const stillCatalog = {
    books: [bookCandidate(miraBook, "Mira", castTerms, concepts)],
    cast: [
      castCandidate({ slug: "mira", name: "Mira", species: "heron", role: "The Learner", bookSlug: "mastery", bookTitle: miraBook.title, topic: "Courage", portrait: null }, { lead: true }),
      castCandidate({ slug: "ansel", name: "Ansel", species: "heron", role: "The Guide", bookSlug: "mastery", bookTitle: miraBook.title, topic: "Courage", portrait: null }),
      castCandidate({ slug: "the-otter", name: "The Otter", species: "river otter", role: "The Shortcut", bookSlug: "mastery", bookTitle: miraBook.title, topic: "Courage", portrait: null }),
    ],
  };
  const cast = searchCatalog(stillCatalog, "still").find((s) => s.type === "cast")!;
  assert(cast.items[0].title === "Mira" && cast.items[1].title === "Ansel", "lead tiebreak: protagonist first inside her own cast");
}

// ---- Published-only Books (CG ruling, 2026-10-28) ----------------
// Public search shows only what is published and buyable: a
// ready_for_qa book never appears in the Books section, not even on
// its exact title, and earns its cast no book boost. Its people stay
// findable in Cast, which is the deliberately public roster. (The
// fixtures above carry no status, which bookCandidate reads as
// complete, i.e. published.)
{
  const qaCatalog = {
    books: [
      bookCandidate({ ...pennyBook, status: "ready_for_qa" }, "Penny", ["Penny squirrel", "Bram badger", "Hazel squirrel"], ["assets"]),
      bookCandidate(miraBook, "Mira", castTerms, concepts),
    ],
    cast: moneyCatalog.cast,
  };
  const pennySections = searchCatalog(qaCatalog, "penny");
  assert(!pennySections.some((s) => s.type === "books"), "published-only: ready_for_qa book absent from Books on a name query");
  const pennyCast = pennySections.find((s) => s.type === "cast");
  assert(!!pennyCast && pennyCast.items.some((i) => i.title === "Penny"), "published-only: the same book's lead still appears in Cast");

  const titleSections = searchCatalog(qaCatalog, "Penny the Squirrel and the Acorn Orchard");
  assert(
    !(titleSections.find((s) => s.type === "books")?.items || []).some((i) => i.meta.slug === "richdadpoordad"),
    "published-only: exact title query still returns no Books hit for a ready_for_qa book"
  );
  assert(
    (titleSections.find((s) => s.type === "cast")?.items || []).some((i) => i.title === "Penny"),
    "published-only: exact title query finds Penny in Cast via her book title"
  );

  // Money queries over a shelf of unpublished Money books: the
  // Books section is omitted entirely while Cast still answers.
  // That is the live state until Penny and Maisie publish.
  const qaMoney = {
    books: [
      bookCandidate({ ...pennyBook, status: "ready_for_qa" }, "Penny", ["Penny squirrel"], ["assets"]),
      bookCandidate({ ...maisieBook, status: "ready_for_qa" }, "Maisie", ["Maisie mouse"], ["compounding"]),
    ],
    cast: moneyCatalog.cast,
  };
  const moneySections = searchCatalog(qaMoney, "book about money");
  assert(!moneySections.some((s) => s.type === "books"), "published-only: money query over unpublished Money books has no Books section");
  assert((moneySections.find((s) => s.type === "cast")?.items || []).length > 0, "published-only: money query still returns Cast with Books empty");

  // A complete book in the same catalog is unaffected.
  const miraSections = searchCatalog(qaCatalog, "mira");
  assert(
    (miraSections.find((s) => s.type === "books")?.items || []).some((i) => i.meta.slug === "mastery"),
    "published-only: the complete book still appears in Books"
  );
}

// Renderer wiring: Books and Audio cards are cover-only (CG,
// 2026-10-28: the section header names the kind and the cover art
// carries the title, so no title/subtitle text renders under those
// covers). The title survives in the card's title attribute,
// aria-label, and image alt. Cast cards keep name + role text.
{
  const { readFileSync } = await import("node:fs");
  const header = readFileSync(new URL("../src/components/SiteHeader.astro", import.meta.url), "utf8");
  const coverStart = header.indexOf("function coverCard");
  const coverEnd = header.indexOf("function optionHtml");
  assert(coverStart >= 0 && coverEnd > coverStart, "renderer: coverCard found in SiteHeader");
  const coverCard = header.slice(coverStart, coverEnd);
  assert(!coverCard.includes("line-clamp-2") && !coverCard.includes("esc(item.subtitle)"), "renderer: cover card renders no title/subtitle text rows");
  assert(coverCard.includes('aria-label="') && coverCard.includes("esc(item.title)"), "renderer: cover card carries the title in aria-label");
  assert(coverCard.includes('alt="\' + esc(item.title)'), "renderer: cover image alt is the full title");
  assert(coverCard.includes('title="\' + esc(item.title)'), "renderer: cover card title attribute is the full title");
  const castStart = header.indexOf('if (item.type === "cast")');
  const castEnd = header.indexOf('if (item.type === "audio")');
  const castCard = header.slice(castStart, castEnd);
  assert(castCard.includes("esc(item.title)") && castCard.includes("esc(role)"), "renderer: cast card still shows name + role text");
  const audioBranch = header.slice(castEnd, header.indexOf('if (item.type === "video")'));
  assert(audioBranch.includes("coverCard(item, id,") && audioBranch.includes("M3 10v4h4l5"), "renderer: audio card keeps its speaker play badge on the cover");
}

if (failures) { console.error(failures + " search test(s) failed"); process.exit(1); }
console.log("All search tests passed.");
