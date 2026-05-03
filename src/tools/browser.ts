import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { createArtifactStore, screenshotsDirPath, writeOutputArtifact } from "../missions/artifacts";
import { missionDirectory } from "../missions/store";
import { assertBrowserRuntimePolicy, classifyBrowserInputSafety } from "./browser-guard";
import { withEphemeralChromiumPage } from "./browser-session";
import type { ToolAction } from "./types";
import type { Page } from "playwright";

const urlField = z.string().min(1).refine((s) => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}, "Invalid URL");

const navigateInputSchema = z.object({
  url: urlField,
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional().default("domcontentloaded")
});

const navigateOutputSchema = z.object({
  url: z.string(),
  title: z.string(),
  finalUrl: z.string()
});

const snapshotInputSchema = z.object({
  url: urlField,
  maxChars: z.number().int().min(1_000).max(200_000).optional().default(80_000)
});

const snapshotOutputSchema = z.object({
  url: z.string(),
  artifactRelativePath: z.string(),
  truncated: z.boolean(),
  preview: z.string(),
  totalChars: z.number().int().nonnegative()
});

const screenshotInputSchema = z.object({
  url: urlField,
  fullPage: z.boolean().optional().default(false)
});

const screenshotOutputSchema = z.object({
  url: z.string(),
  artifactRelativePath: z.string()
});

const locatorFields = z.object({
  url: urlField,
  selector: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional()
});

const locatorInputSchema = locatorFields.refine((v) => Boolean(v.selector) || (Boolean(v.role) && Boolean(v.name)), {
  message: "Provide selector or both role and name"
});

const clickOutputSchema = z.object({ url: z.string(), clicked: z.literal(true) });

const fillInputSchema = locatorFields
  .extend({
    value: z.string()
  })
  .refine((v) => Boolean(v.selector) || (Boolean(v.role) && Boolean(v.name)), {
    message: "Provide selector or both role and name"
  });

const fillOutputSchema = z.object({ url: z.string(), filled: z.literal(true) });

const pressInputSchema = z.object({
  url: urlField,
  key: z.string().min(1)
});

const pressOutputSchema = z.object({ url: z.string(), key: z.string(), pressed: z.literal(true) });

async function loadPolicyOrThrow(cwd: string) {
  const paths = resolveWorkspacePaths(cwd);
  const policy = await loadWorkspacePolicy(paths.policyFile);
  if (!policy.ok) {
    throw new Error(`policy.yaml invalid: ${policy.message}`);
  }
  return policy.value;
}

async function prepareBrowserRun(cwd: string, toolName: string, input: unknown) {
  const policy = await loadPolicyOrThrow(cwd);
  assertBrowserRuntimePolicy(policy);
  const safety = classifyBrowserInputSafety(toolName, input, policy);
  if (!safety.ok) {
    throw new Error(safety.reason);
  }
  return policy;
}

function resolveLocator(page: Page, input: z.infer<typeof locatorInputSchema>) {
  if (input.selector) {
    return page.locator(input.selector);
  }
  return page.getByRole(input.role as Parameters<Page["getByRole"]>[0], { name: input.name ?? undefined });
}

const PREVIEW_LEN = 4_000;

export const browserTools: ToolAction<unknown, unknown>[] = [
  {
    name: "browser.navigate",
    description: "Open a URL in a headless browser and return the document title (approval-gated, policy allowlist).",
    inputSchema: navigateInputSchema,
    outputSchema: navigateOutputSchema,
    riskLevel: "high",
    sideEffect: "network",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = navigateInputSchema.parse(input);
      const prep = await prepareBrowserRun(context.cwd, "browser.navigate", parsed);
      return withEphemeralChromiumPage(prep.browser_max_navigation_ms, async (page) => {
        await page.goto(parsed.url, { waitUntil: parsed.waitUntil });
        const title = await page.title();
        return {
          url: parsed.url,
          title,
          finalUrl: page.url()
        };
      });
    }
  },
  {
    name: "browser.snapshot",
    description:
      "Capture an accessibility tree snapshot as JSON text (trimmed), saved under mission artifacts, with a short preview in the output.",
    inputSchema: snapshotInputSchema,
    outputSchema: snapshotOutputSchema,
    riskLevel: "high",
    sideEffect: "network",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = snapshotInputSchema.parse(input);
      const prep = await prepareBrowserRun(context.cwd, "browser.snapshot", parsed);
      const tree = await withEphemeralChromiumPage(prep.browser_max_navigation_ms, async (page) => {
        await page.goto(parsed.url, { waitUntil: "domcontentloaded" });
        const title = await page.title();
        const bodyText = await page.locator("body").innerText().catch(() => "");
        return { title, url: page.url(), bodyText };
      });
      const text = JSON.stringify(tree, null, 2);
      const truncated = text.length > parsed.maxChars;
      const stored = truncated ? `${text.slice(0, parsed.maxChars)}\n[truncated to ${parsed.maxChars} chars]\n` : text;
      const fileName = `browser-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      const written = await writeOutputArtifact(context.cwd, context.missionId, fileName, stored);
      const store = createArtifactStore(context.cwd);
      await store.registerArtifact({
        missionId: context.missionId,
        type: "browser_snapshot",
        title: "Browser accessibility snapshot",
        relativePath: written.relativePath,
        metadata: {
          url: parsed.url,
          truncated,
          totalChars: text.length
        }
      });
      return {
        url: parsed.url,
        artifactRelativePath: written.relativePath,
        truncated,
        preview: stored.slice(0, PREVIEW_LEN) + (stored.length > PREVIEW_LEN ? "\n[preview truncated]\n" : ""),
        totalChars: text.length
      };
    }
  },
  {
    name: "browser.screenshot",
    description: "Navigate and save a PNG screenshot under artifacts/screenshots/ (approval-gated).",
    inputSchema: screenshotInputSchema,
    outputSchema: screenshotOutputSchema,
    riskLevel: "high",
    sideEffect: "network",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = screenshotInputSchema.parse(input);
      const prep = await prepareBrowserRun(context.cwd, "browser.screenshot", parsed);
      const paths = resolveWorkspacePaths(context.cwd);
      const missionDir = missionDirectory(paths.missionsDir, context.missionId);
      const dir = screenshotsDirPath(missionDir);
      await mkdir(dir, { recursive: true });
      const fileName = `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      const absolutePath = path.join(dir, fileName);

      await withEphemeralChromiumPage(prep.browser_max_navigation_ms, async (page) => {
        await page.goto(parsed.url, { waitUntil: "domcontentloaded" });
        const buf = await page.screenshot({ fullPage: parsed.fullPage, type: "png" });
        await writeFile(absolutePath, buf);
      });

      const relativePath = path.join("artifacts", "screenshots", fileName).replace(/\\/g, "/");
      const store = createArtifactStore(context.cwd);
      await store.registerArtifact({
        missionId: context.missionId,
        type: "browser_screenshot",
        title: "Browser screenshot",
        relativePath,
        metadata: { url: parsed.url, fullPage: parsed.fullPage }
      });

      return { url: parsed.url, artifactRelativePath: relativePath };
    }
  },
  {
    name: "browser.click",
    description: "Navigate, then click an element by role+name or CSS selector (approval-gated).",
    inputSchema: locatorInputSchema,
    outputSchema: clickOutputSchema,
    riskLevel: "high",
    sideEffect: "network",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = locatorInputSchema.parse(input);
      const prep = await prepareBrowserRun(context.cwd, "browser.click", parsed);
      await withEphemeralChromiumPage(prep.browser_max_navigation_ms, async (page) => {
        await page.goto(parsed.url, { waitUntil: "domcontentloaded" });
        await resolveLocator(page, parsed).click();
      });
      return { url: parsed.url, clicked: true };
    }
  },
  {
    name: "browser.fill",
    description: "Navigate, then fill an input (role+name or selector) with a string value (approval-gated).",
    inputSchema: fillInputSchema,
    outputSchema: fillOutputSchema,
    riskLevel: "high",
    sideEffect: "network",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = fillInputSchema.parse(input);
      const prep = await prepareBrowserRun(context.cwd, "browser.fill", parsed);
      await withEphemeralChromiumPage(prep.browser_max_navigation_ms, async (page) => {
        await page.goto(parsed.url, { waitUntil: "domcontentloaded" });
        await resolveLocator(page, parsed).fill(parsed.value);
      });
      return { url: parsed.url, filled: true };
    }
  },
  {
    name: "browser.press",
    description: "Navigate, then send a keyboard key (e.g. Enter) on the focused element (approval-gated).",
    inputSchema: pressInputSchema,
    outputSchema: pressOutputSchema,
    riskLevel: "high",
    sideEffect: "network",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = pressInputSchema.parse(input);
      const prep = await prepareBrowserRun(context.cwd, "browser.press", parsed);
      await withEphemeralChromiumPage(prep.browser_max_navigation_ms, async (page) => {
        await page.goto(parsed.url, { waitUntil: "domcontentloaded" });
        await page.keyboard.press(parsed.key);
      });
      return { url: parsed.url, key: parsed.key, pressed: true };
    }
  }
];
