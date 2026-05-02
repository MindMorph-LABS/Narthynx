export type RoutedInteractiveInput =
  | { kind: "empty" }
  | { kind: "slash"; raw: string }
  | { kind: "shell"; raw: string }
  | { kind: "context_file"; raw: string }
  | { kind: "note"; raw: string }
  | { kind: "natural"; text: string };

export function routeInteractiveInput(line: string): RoutedInteractiveInput {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return { kind: "empty" };
  }

  if (trimmed.startsWith("/")) {
    return { kind: "slash", raw: trimmed };
  }

  if (trimmed.startsWith("!")) {
    return { kind: "shell", raw: trimmed };
  }

  if (trimmed.startsWith("@")) {
    return { kind: "context_file", raw: trimmed };
  }

  if (trimmed.startsWith("#")) {
    return { kind: "note", raw: trimmed };
  }

  return { kind: "natural", text: trimmed };
}
