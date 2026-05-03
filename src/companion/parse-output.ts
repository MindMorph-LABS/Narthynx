import { companionStructuredOutputSchema, type CompanionStructuredOutput } from "./models";

/** Strip markdown code fences occasionally returned by hosted models; returns inner JSON-ish text or undefined. */
export function stripPotentialJsonFence(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "");
    const end = t.lastIndexOf("```");
    if (end >= 0) {
      t = t.slice(0, end).trim();
    }
  }
  return t;
}

export function parseCompanionStructuredOutput(rawContent: string):
  | { ok: true; value: CompanionStructuredOutput }
  | { ok: false; error: string } {
  try {
    const stripped = stripPotentialJsonFence(rawContent);
    const parsed: unknown = JSON.parse(stripped);
    const safe = companionStructuredOutputSchema.safeParse(parsed);
    if (!safe.success) {
      return { ok: false, error: safe.error.message };
    }
    return { ok: true, value: safe.data };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}
