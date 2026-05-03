import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify `X-Hub-Signature-256` from GitHub webhooks (HMAC SHA-256 hex). */
export function verifyGithubWebhookSignature(
  rawBody: string,
  signature256Header: string | undefined,
  secret: string
): boolean {
  if (!secret || !signature256Header || !signature256Header.startsWith("sha256=")) {
    return false;
  }
  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expected = `sha256=${expectedHex}`;
  const a = Buffer.from(signature256Header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
