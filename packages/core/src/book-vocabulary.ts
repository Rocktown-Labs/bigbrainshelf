/** Existing matter vocabulary derivation, shared by rendering and adoption counts. */
export function bookVocabulary(bible: any) {
  const vocabRaw: any[] = Array.isArray(bible?.vocab) ? bible.vocab : [];
  const ladder: any[] = Array.isArray(bible?.conceptLadder) ? bible.conceptLadder : [];
  return vocabRaw.map((v: any) => {
    let def = typeof v.definition === "string" ? v.definition : "";
    if (!def) {
      const term = String(v.term ?? "").toLowerCase();
      const hit = ladder.find((c: any) => String(c.idea ?? "").toLowerCase().includes(term));
      if (hit) def = String(hit.idea);
    }
    return { term: String(v.term ?? ""), storyName: String(v.storyName ?? ""), definition: def };
  });
}
