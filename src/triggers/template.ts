/** Resolve `a.b.c` against a nested object (trigger template context). */
export function getPath(obj: unknown, pathStr: string): unknown {
  const parts = pathStr
    .trim()
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    if (typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Replace `{{ path.to.value }}` using getPath on ctx. */
export function renderTemplate(tpl: string, ctx: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key: string) => {
    const v = getPath(ctx, key);
    if (v === undefined || v === null) {
      return "";
    }
    return String(v);
  });
}

export function renderDedupKey(parts: string[], ctx: Record<string, unknown>): string {
  const rendered = parts.map((p) => renderTemplate(p, ctx).trim()).filter(Boolean);
  if (rendered.length === 0) {
    return "";
  }
  return rendered.join("|");
}
