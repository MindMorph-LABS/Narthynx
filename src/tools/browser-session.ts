import { chromium } from "playwright";
import type { Page } from "playwright";

/** Single headless Chromium context; launches and closes around one callback (v1 ephemeral session). */
export async function withEphemeralChromiumPage<T>(navigationTimeoutMs: number, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(navigationTimeoutMs);
    page.setDefaultNavigationTimeout(navigationTimeoutMs);
    return await fn(page);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
