// Shared source normalization, derived without inventing story content.
export function normalizeBible(bible: any): any {
  if (!bible || typeof bible !== "object") return bible;
  const b = { ...bible };

  if (!Array.isArray(b.characters) || !b.characters.length) {
    const cast: any[] = [];
    if (b.protagonist?.name) cast.push(b.protagonist);
    for (const c of b.supportingCast ?? []) if (c?.name) cast.push(c);
    for (const c of b.newCharacters ?? []) if (c?.name) cast.push(c);
    if (cast.length) b.characters = cast;
  }

  if (Array.isArray(b.conceptLadder) && Array.isArray(b.metaphorBank)) {
    const bank = new Map<string, any>(
      b.metaphorBank.map((m: any) => [String(m?.storyChapter ?? ""), m])
    );
    b.conceptLadder = b.conceptLadder.map((e: any) => {
      if (e?.metaphor) return e;
      const m = bank.get(String(e?.storyChapter ?? e?.chapter ?? ""));
      return m?.metaphor ? { ...e, metaphor: m.metaphor } : e;
    });
  }

  return b;
}

