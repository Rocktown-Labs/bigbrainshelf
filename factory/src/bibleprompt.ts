// Super bible prompt, embedded from super_bible_prompt.md ("## THE PROMPT" section).
// Placeholders are filled with String.replace (NOT template interpolation):
// {book_title} {book_subject} {cover_description} {chapter_summaries} {character_library}

const TEMPLATE = `

You are a children's book author and a technical educator. You will read a non-fiction book and design a kids' story-and-coloring-book adaptation. Do NOT write the stories yet. Produce a STORY BIBLE.

### INPUTS

**Book title:** {book_title}
**Book subject (one line):** {book_subject}
**Cover description:** {cover_description}
  (Describe the cover art: animal, object, scene, colors. If there is a prominent animal or character, name it.)
**Table of contents with chapter summaries:**
{chapter_summaries}
  (One paragraph per chapter: what it teaches, key mechanisms, important terms.)

**Existing character library (reuse these if they fit; do not duplicate):**
{character_library}
  (JSON list of established characters with their visual descriptions. If a character from the library fits this book's world, cast them instead of inventing a new one.)

### OUTPUT

Reply with ONLY a JSON object with these exact sections:

\`\`\`json
{
  "bookTitle": "an original, appealing book title for kids. Never mention the source book's title.",
  "bigIdea": "one sentence a 6-year-old could repeat: what problem this book solves",
  "protagonist": {
    "name": "first name",
    "species": "animal or creature type",
    "source": "cover | library | invented",
    "personality": ["trait 1", "trait 2"],
    "want": "the one want or flaw that drives the whole book (e.g. 'wants to deliver things faster')",
    "visual": "fixed visual description, 40 words or fewer, written to be pasted VERBATIM into every image prompt. Describe SHAPE and features only. NEVER use color words (no 'blue', 'red', 'white', 'green', etc.). NEVER put text on clothing. Mention silhouette-relevant traits."
  },
  "supportingCast": [
    {
      "name": "first name",
      "species": "must be a clearly different species and silhouette from the protagonist",
      "role": "their job in the stories (e.g. 'gives the orders', 'packs the cargo')",
      "realMapsTo": "the concept or role this character embodies, in generic field words only (e.g. 'the client program'); never name a work, an author, or anyone's framework",
      "visual": "same rules as protagonist visual"
    }
  ],
  "setting": "one-line description of the story world",
  "locations": ["4-6 distinct places; different chapters happen in different places"],
  "conceptLadder": [
    {
      "storyChapter": "S1, S2, ... (story chapter number, not source chapter)",
      "sourceRef": "OMIT this field entirely. The bible never records source locations (2026-10-31 no-source-trail rule).",
      "title": "working story title",
      "idea": "the ONE new idea this chapter teaches that earlier chapters did not",
      "mechanism": "how it actually works, in plain words: cause and effect, order of steps, failure case",
      "buildsOn": "which earlier story chapter's idea this builds on, or 'none'",
      "core": true/false
    }
  ],
  "metaphorBank": [
    {
      "storyChapter": "S1, ...",
      "metaphor": "one concrete kid-level metaphor: a physical object or activity",
      "why": "how the metaphor preserves the real mechanism (what it does, why it matters, what goes wrong without it)",
      "fidelity": "accurate | simplified",
      "simplificationHides": "if simplified, what the metaphor hides (and which later chapter corrects it, if any)"
    }
  ],
  "arc": {
    "act1": "the want (which chapters)",
    "act2": "escalating challenges (which chapters)",
    "act3": "the payoff (which chapters)"
  },
  "runningGags": ["3-4 recurring motifs that evolve across chapters"],
  "openingJob": "ONE concrete physical job the protagonist is in the middle of when the story opens, with a visible finish line (e.g. 'helping Pip move her cakes across the harbor to open her bakery on Saturday'). Under 30 words. Every chapter's idea must arrive as a tool the protagonist grabs mid-job, never as a lesson.",
  "worldInventory": {
    "exists": ["20-40 plain nouns: the physical things that exist in this story world (its places, objects, creatures, weather, tools). Every object used by any chapter metaphor must be listed here."],
    "doesNotExist": ["10-20 things from the source book's real-world domain that must NEVER appear in this story world: real technology, real-world labels, real places, anything the animal world has no version of."],
    "forbiddenSourceTerms": ["every technical term from the source book that kids must never see in story text or image prompts, lowercase, including plurals and variants. Each one must also appear as a vocab term with a storyName."]
  },
  "bannedOpeners": ["4-8 chapter-opening phrases THIS book must never use, derived from this book's own source and early chapters: e.g. the stale old-way contrast the first chapters already used up. Phrases only, lowercase."],
  "starNote": "one short clause naming the character who must not star every chapter, e.g. 'do not make the lead the star every chapter'. Generated from THIS book's cast.",
  "vocab": [
    {"term": "real term from the book", "storyName": "what it is called in the story", "definition": "one plain sentence that says what the term really means, simple enough to read aloud"}
  ],
  "series": {"name": "the name of the series this book belongs to if the source is part of one, otherwise null", "bookNumber": 1, "nextBookTease": "one short line teasing the next book in the series, or null"},
  "ageBand": "the target age range as text: '4 to 8' (default), '9 to 13', or '14 to 18'",
  "sourceKind": "technical | ideas. technical when the source is a technical field whose real terms are the curriculum (computing, engineering, a science's methods). ideas when the source is advice, philosophy, history, biography, or any work whose value is its ideas rather than its vocabulary. The classification drives rule 12e.",
  "newCharacters": [
    {
      "name": "first name",
      "species": "animal or creature type",
      "visual": "same verbatim rules: shape only, no color words, 40 words or fewer",
      "firstAppears": "S#",
      "addToLibrary": true
    }
  ]
}
\`\`\`

### RULES

1. **Protagonist source priority (IP hygiene):** If the cover has a prominent animal or character, check WHOSE it is first. If it is the technology's own official mascot (Go's gopher, Python's snake, Rust's crab, Docker's whale), use it (a kids' version). If it is the PUBLISHER's cover art (e.g. O'Reilly's animal covers), do NOT use the same species: pick a different animal from the same family, or invent an original one, and note the swap in the bible. We remix the ideas, never the trade dress. Else, check the character library for a fit. Else, invent a fitting animal. Never use a human as protagonist.

2. **Concept ladder:** Each story chapter teaches exactly ONE new idea. If a source chapter contains multiple distinct ideas, split it into multiple story chapters. If two source chapters overlap, assign each a distinct angle. Never give two story chapters the same idea. Mark \`core: true\` for the chapters that form the essential short edition (aim for 60-70% of chapters).

3. **Metaphor bank:** Every story chapter gets a DIFFERENT physical metaphor object. No object may be used twice. Rotate across sports, toys, marbles, games, animals, food, vehicles, household objects, nature. Each metaphor must preserve the real mechanism. Mark fidelity honestly; if simplified, note what it hides and which chapter corrects it.

4. **Characters:** Maximum 3 total (1 protagonist + up to 2 supporting). Each must be a clearly different species and silhouette. Each supporting character should embody a real role or concept from the book. Character visuals must be concrete, repeatable, and image-safe: no arms holding things unless the species has them; if a character cannot hold props, say where props sit instead. NEVER use color words in any visual description. NEVER describe text, labels, or writing on the character.

**Character copy rule (blurb vs bio):** Each character has ONE short defining take (their role and traits). Character prose is written in two layers that must never repeat each other: the short blurb states the defining take once, and the longer bio (two paragraphs, written for the storefront's Meet the Cast pages) must ADD new texture only: habits, small scenes, relationships with castmates, what is at stake for them. A bio that restates the blurb in near-verbatim form is a defect. Invent texture, not plot: no new story events beyond what the bible establishes.

5. **World:** 4-6 distinct locations. Assign each story chapter a location; no two consecutive chapters share one.

6. **Arc:** Map story chapters onto 3 acts. Only the final chapter ends with the big payoff (something deployed, launched, shipped, opened, going live). Other chapters end with a small win plus a hook into the next.

7. **Vocab:** 5-10 real terms, each given a story name and a one-sentence plain definition for the glossary at the back of the book. They appear in narration as names, never as lectures, never as text in images.

8. **New characters:** If the book needs characters beyond the library, define them here with \`addToLibrary: true\` so they join the reusable universe.

9. **No em dashes** in any text.

10. **Opening job:** The story opens mid-job, not at a lesson. Every chapter's idea must reach the protagonist as a tool grabbed while doing the opening job (or the job it grows into), with the job's finish line as the book's payoff. If a chapter's idea cannot arrive as a tool mid-job, re-shape the chapter's angle until it can.

11. **World inventory:** \`exists\` lists ONLY plain physical nouns a drawing could show, and must cover every object any chapter metaphor uses: if a metaphor needs it, it exists and is listed. \`doesNotExist\` lists the source domain's real-world things this world has no version of (real computers, phones, screens, brand names, real city names, and the like, adapted to the source). \`forbiddenSourceTerms\` lists EVERY technical term from the source, lowercase with plurals and spelling variants, and every one of them must also appear in \`vocab\` with a \`storyName\`. Nothing from \`doesNotExist\` or \`forbiddenSourceTerms\` may appear in this bible's own descriptive fields (setting, locations, metaphors, arc, gags): the ONLY places a real term may live are \`vocab.term\` and a supporting character's \`realMapsTo\`.

12. **Story names only:** Story text and image prompts may use ONLY the \`storyName\` for every taught term, never the real term. The real term lives in \`vocab.term\` (and the grown-ups glossary) and nowhere else in the story.

12b. **Plain terms, not the author's labels:** When the source is a work of advice, philosophy, or self-improvement rather than a technical field, its author often brands the ideas with signature labels. Those labels are the author's fingerprint: they go in \`forbiddenSourceTerms\`, NEVER in \`vocab.term\`. A \`vocab.term\` for such a source is a plain, generic phrase any book could use for the same idea (what a dictionary or a teacher would call it, not what THIS author calls it). Technical fields are exempt: their terms are the field's common words, and teaching the real word is the point. Test: if the phrase only exists because this author coined or popularized it, it is a label, not a term.

12c. **No source trail (2026-10-31):** This bible is a permanent production record and must not let a reader reconstruct where the book came from. Never name the source work or its author anywhere in the output. No source chapter or page references (production slicing is transient and lives outside the bible; omit \`sourceRef\`). The book's slug is minted from its own title, never from the source. We remix ideas; the paperwork tells the story's own story.

12d. **Write to the age band (2026-10-31):** Every kid-facing phrase the chapter writers consume (story names, definitions, ladder ideas) is written for THIS book's \`ageBand\`. For 4 to 8: short simple sentences, everyday words, one idea per sentence, definitions a child could say back in their own words. Story names are plain story phrases, never capitalized concept codenames: prose may say "the pull she felt", but nothing is branded as "the Pull", and the glossary explains ideas in simple words instead of naming concepts at all where plain description works. Older bands (9 to 13, 14 to 18) scale vocabulary, sentence length, and abstraction up to match.

12e. **Classify the source; the regime follows (2026-10-31):** Set \`sourceKind\` first. TECHNICAL sources: the field's real terms are the curriculum, so \`vocab.term\` carries them proudly and the glossary teaches the real words; \`forbiddenSourceTerms\` still guards story text and images (terms live in the glossary and in \`realMapsTo\`, nowhere else). IDEAS sources: the book is an ORIGINAL story that teaches the source's ideas in its own world and its own words, not an adaptation wearing the source's labels; \`vocab.term\` is a plain phrase, and the author's signature labels are forbidden. Either way, \`forbiddenSourceTerms\` is BUILT FROM THE SOURCE ITSELF, systematically, never hand-tuned to one book: the source's title and author-name forms, every coined or signature label, every distinctive named framework or concept, and (technical) every curriculum term, each lowercase with plurals and variants. A source the generator has never seen before gets the same treatment as a familiar one.

13. **Per-book writing data:** \`bannedOpeners\` and \`starNote\` are generated from THIS book's cast and source, not copied from any other book. The banned openers are the stale framings this book's early chapters burn up (typically the old-way-vs-new-way contrast), so later chapters are forbidden from re-opening with them.

`;

export interface BookInfo {
  title: string;
  subject: string;
  cover_description: string;
  chapters: { title: string; summary: string }[];
}

export interface LibraryChar {
  name: string; species: string; visual: string; personality?: string[];
}

export function buildBiblePrompt(info: BookInfo, library: LibraryChar[]): string {
  const chapters_md = info.chapters.map(c => `**${c.title}**\n${c.summary}`).join("\n");
  const lib_md = library.length ? JSON.stringify(library, null, 1) : "(library is empty)";
  return TEMPLATE
    .replace("{book_title}", info.title)
    .replace("{book_subject}", info.subject)
    .replace("{cover_description}", info.cover_description)
    .replace("{chapter_summaries}", chapters_md)
    .replace("{character_library}", lib_md);
}
