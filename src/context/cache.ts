import type { ContextItem } from "./types";

export interface CacheFingerprintRollup {
  count: number;
}

export function rollupFingerprints(items: Pick<ContextItem, "contentSha256">[]): CacheFingerprintRollup {
  return {
    count: items.filter((i) => Boolean(i.contentSha256)).length
  };
}
