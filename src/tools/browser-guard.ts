import type { WorkspacePolicy } from "../config/load";

export function isBrowserToolName(name: string): boolean {
  return name.startsWith("browser.");
}

export function urlAllowedForBrowser(urlString: string, policy: WorkspacePolicy): boolean {
  if (policy.browser_hosts_allow.length === 0) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  if (url.protocol === "file:" || url.protocol === "javascript:" || url.protocol === "data:") {
    return false;
  }

  const href = url.href;
  const host = url.hostname.toLowerCase();

  for (const pattern of policy.browser_hosts_allow) {
    if (pattern === "about:blank" && urlString === "about:blank") {
      return true;
    }

    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (href.startsWith(prefix)) {
        return true;
      }
      continue;
    }

    if (href.startsWith(pattern)) {
      return true;
    }

    try {
      const pu = new URL(pattern);
      if (pu.origin === url.origin && href.startsWith(pattern)) {
        return true;
      }
    } catch {
      const p = pattern.toLowerCase();
      if (host === p || host.endsWith(`.${p}`)) {
        return true;
      }
    }
  }

  return false;
}

export function extractBrowserUrlsFromInput(toolName: string, input: unknown): string[] {
  if (!isBrowserToolName(toolName) || typeof input !== "object" || input === null) {
    return [];
  }
  const rec = input as Record<string, unknown>;
  const url = rec.url;
  if (typeof url === "string" && url.length > 0) {
    return [url];
  }
  return [];
}

export function classifyBrowserInputSafety(
  toolName: string,
  input: unknown,
  policy: WorkspacePolicy
): { ok: true } | { ok: false; reason: string } {
  if (!isBrowserToolName(toolName)) {
    return { ok: true };
  }

  if (policy.browser === "block") {
    return { ok: true };
  }

  const urls = extractBrowserUrlsFromInput(toolName, input);
  if (urls.length === 0) {
    return { ok: false, reason: `${toolName} requires a valid url in the tool input.` };
  }

  for (const u of urls) {
    if (!urlAllowedForBrowser(u, policy)) {
      return {
        ok: false,
        reason: `URL is not allowed by browser_hosts_allow: ${u}`
      };
    }
  }

  return { ok: true };
}

export function assertBrowserRuntimePolicy(policy: WorkspacePolicy): void {
  if (policy.browser === "block") {
    throw new Error("Browser tools are blocked by policy (browser: block).");
  }
  if (!policy.allow_network) {
    throw new Error("Browser tools require allow_network: true in policy.yaml.");
  }
  if (policy.browser_hosts_allow.length === 0) {
    throw new Error("browser_hosts_allow must list at least one allowed URL prefix or hostname.");
  }
}
