import type { ContextDietConfig } from "../config/context-diet-config";

export function truncateFileForPack(content: string, diet: ContextDietConfig): string {
  const { max_bytes, head_lines, tail_lines } = diet.file_truncation;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= max_bytes) {
    return content;
  }
  const lines = content.split(/\r?\n/);
  if (lines.length <= head_lines + tail_lines) {
    return content;
  }
  const head = lines.slice(0, head_lines).join("\n");
  const tail = lines.slice(-tail_lines).join("\n");
  const merged = `${head}\n\n… [truncated middle ${lines.length - head_lines - tail_lines} lines] …\n\n${tail}`;
  const mergedBytes = Buffer.byteLength(merged, "utf8");
  if (mergedBytes <= max_bytes) {
    return merged;
  }
  return `${merged.slice(0, max_bytes)}\n… [truncated to ${max_bytes} bytes] …`;
}
