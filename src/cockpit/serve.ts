import { serve } from "@hono/node-server";

import { doctorWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { createCockpitApp } from "./app";
import { resolveCockpitStaticRoot } from "./paths";
import { resolveCockpitAuthToken } from "./token";

export interface CockpitListenInfo {
  url: string;
  token: string;
  wroteTokenFile: boolean;
}

export interface CockpitServerOptions {
  cwd: string;
  port: number;
  host: string;
  dangerListenOnLan: boolean;
  importMetaUrl: string;
  onListening?: (info: CockpitListenInfo) => void;
}

const DEFAULT_PORT = 17890;

export function resolveCockpitPort(): number {
  const raw = process.env.NARTHYNX_COCKPIT_PORT?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) {
      return n;
    }
  }
  return DEFAULT_PORT;
}

export async function runCockpitServer(options: CockpitServerOptions): Promise<void> {
  const { cwd, port, host, dangerListenOnLan, importMetaUrl, onListening } = options;

  const doctor = await doctorWorkspace(cwd);
  if (!doctor.ok) {
    throw new Error("Workspace is not healthy. Run: narthynx init");
  }

  const paths = resolveWorkspacePaths(cwd);
  const { token, wroteFile } = await resolveCockpitAuthToken(paths);
  const staticRoot = resolveCockpitStaticRoot(importMetaUrl);

  const app = createCockpitApp({
    cwd,
    staticRoot,
    bearerToken: token,
    allowLan: dangerListenOnLan
  });

  if (dangerListenOnLan && host !== "0.0.0.0") {
    throw new Error("Internal: dangerListenOnLan requires host 0.0.0.0");
  }

  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: host
    },
    (info) => {
      const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host;
      const url = `http://${urlHost}:${info.port}`;
      onListening?.({ url, token, wroteTokenFile: wroteFile });
    }
  );

  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { DEFAULT_PORT };
