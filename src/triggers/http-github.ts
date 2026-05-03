import type { Context } from "hono";

import { ingestTriggerEvent } from "./engine";
import { verifyGithubWebhookSignature } from "./github-signature";

/** Max webhook body size (bytes) — fail closed on oversized payloads. */
export const MAX_GITHUB_WEBHOOK_BYTES = 512 * 1024;

export async function handleGithubTriggerWebhook(cwd: string, c: Context, secret: string): Promise<Response> {
  if (!secret) {
    return c.json({ error: "GitHub webhook secret not configured", code: "trigger_secret_missing" }, 503);
  }

  const rawBody = await c.req.text();
  if (rawBody.length > MAX_GITHUB_WEBHOOK_BYTES) {
    return c.json({ error: "Payload too large", code: "payload_too_large" }, 413);
  }

  const sig = c.req.header("x-hub-signature-256");
  if (!verifyGithubWebhookSignature(rawBody, sig, secret)) {
    return c.json({ error: "Invalid signature", code: "invalid_signature" }, 401);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
  }

  const githubEventName = c.req.header("x-github-event") ?? "unknown";

  const result = await ingestTriggerEvent(cwd, {
    source: "github",
    rawBody,
    parsedJson,
    githubEventName
  });

  const status = result.ok ? 200 : 500;
  return c.json(result, status);
}
