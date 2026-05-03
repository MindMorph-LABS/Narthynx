/**
 * Classify OpenAI-compatible base URLs for policy: loopback hosts are treated
 * as local inference (not networked for cloud_model_sensitive_context / allow_network).
 */
export function baseUrlHostIsLoopback(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost") {
      return true;
    }
    if (host === "127.0.0.1" || host === "::1") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** True when the provider should be treated as crossing the network policy boundary. */
export function openAiBaseUrlIsNetworkedForPolicy(baseUrl: string): boolean {
  return !baseUrlHostIsLoopback(baseUrl);
}
