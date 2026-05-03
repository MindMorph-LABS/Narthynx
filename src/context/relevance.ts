/** Token-ish keywords derived from mission text for heuristic ranking. */
export function relevanceKeywords(goalAndTitle: string): Set<string> {
  const words = goalAndTitle
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return new Set(words);
}

export function relevanceScore(labelsAndSnippet: string, keywords: Set<string>): number {
  if (keywords.size === 0) {
    return 0;
  }
  const parts = labelsAndSnippet
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  let hit = 0;
  for (const w of parts) {
    if (keywords.has(w)) {
      hit += 1;
    }
  }
  return hit;
}
