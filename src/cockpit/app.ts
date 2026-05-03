import { readFile } from "node:fs/promises";
import path from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { createCockpitApiRouter } from "./routes/api";

export interface CreateCockpitAppOptions {
  cwd: string;
  staticRoot: string;
  bearerToken: string;
  /** When true, bind may be 0.0.0.0 and CORS allows any origin (no credentials). */
  allowLan: boolean;
}

export function createCockpitApp(options: CreateCockpitAppOptions): Hono {
  const { cwd, staticRoot, bearerToken, allowLan } = options;

  const app = new Hono();

  if (allowLan) {
    app.use(
      "/api/*",
      cors({
        origin: "*",
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"]
      })
    );
  }

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${bearerToken}`) {
      return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
    }
    await next();
  });

  app.route("/api", createCockpitApiRouter(cwd));

  app.use("/*", serveStatic({ root: staticRoot }));

  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api")) {
      return c.json({ error: "Not found", code: "not_found" }, 404);
    }
    try {
      const html = await readFile(path.join(staticRoot, "index.html"), "utf8");
      return c.html(html);
    } catch {
      return c.text("Cockpit UI not built. Run pnpm build.", 503);
    }
  });

  return app;
}
