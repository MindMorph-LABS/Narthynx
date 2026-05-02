export function tokenizeSlashRest(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of value) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error(`Unclosed ${quote} quote in command.`);
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
