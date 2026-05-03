import readline from "node:readline";
import type { Readable } from "node:stream";

export type ApprovalKeyChoice = "approve" | "deny" | "pause" | "edit" | null;

const APPROVAL_KEYPRESS_TIMEOUT_MS = 120_000;

function restoreRawMode(stdin: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }, previousRaw: boolean): void {
  try {
    stdin.setRawMode?.(previousRaw);
  } catch {
    /* best effort — terminal may already be closing */
  }
}

/**
 * Read a single key for [a]/[d]/[p]/[e] when stdin is a TTY.
 * Always restores raw mode in a finally-equivalent path so the shell is not left raw on error or unknown keys.
 * Any other key or Escape cancels (returns null) so the user is never stuck waiting.
 */
export function readApprovalKeyChoice(input: Readable): Promise<ApprovalKeyChoice> {
  if (!input.isTTY) {
    return Promise.resolve(null);
  }

  readline.emitKeypressEvents(input);
  const stdin = input as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  const previousRaw = Boolean(stdin.isRaw);

  return new Promise((resolve) => {
    let finished = false;
    const timeoutRef: { id?: ReturnType<typeof setTimeout> } = {};

    const finish = (choice: ApprovalKeyChoice): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutRef.id !== undefined) {
        clearTimeout(timeoutRef.id);
      }
      restoreRawMode(stdin, previousRaw);
      stdin.removeListener("keypress", onKeypress);
      resolve(choice);
    };

    const onKeypress = (_str: string, key: readline.Key | undefined): void => {
      if (!key || finished) {
        return;
      }

      if (key.ctrl && key.name === "c") {
        finish(null);
        return;
      }

      if (key.name === "escape") {
        finish(null);
        return;
      }

      const seq = key.sequence?.toLowerCase() ?? "";

      if (seq === "a" || key.name === "a") {
        finish("approve");
        return;
      }

      if (seq === "d" || key.name === "d") {
        finish("deny");
        return;
      }

      if (seq === "p" || key.name === "p") {
        finish("pause");
        return;
      }

      if (seq === "e" || key.name === "e") {
        finish("edit");
        return;
      }

      if (seq.length === 1 || (typeof key.name === "string" && key.name.length === 1)) {
        finish(null);
        return;
      }
    };

    try {
      stdin.setRawMode?.(true);
    } catch {
      finish(null);
      return;
    }

    stdin.on("keypress", onKeypress);

    timeoutRef.id = setTimeout(() => finish(null), APPROVAL_KEYPRESS_TIMEOUT_MS);
  });
}