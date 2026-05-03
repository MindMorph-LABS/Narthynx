import YAML from "yaml";

import type { WorkspacePolicy } from "./load";

export const WORKSPACE_DIR_NAME = ".narthynx";
export const CONFIG_FILE_NAME = "config.yaml";
export const POLICY_FILE_NAME = "policy.yaml";
export const MCP_FILE_NAME = "mcp.yaml";
export const GITHUB_FILE_NAME = "github.yaml";
export const CONTEXT_DIET_FILE_NAME = "context-diet.yaml";
export const MISSIONS_DIR_NAME = "missions";
/** Hex-encoded 32-byte salt for per-workspace vault KDF binding. */
export const VAULT_KDF_SALT_FILE_NAME = "vault-kdf.salt";

export const DEFAULT_CONFIG = {
  workspace_version: 1,
  created_by: "narthynx",
  default_policy: POLICY_FILE_NAME,
  missions_dir: MISSIONS_DIR_NAME
} as const;

export const DEFAULT_POLICY: WorkspacePolicy = {
  mode: "ask",
  allow_network: false,
  shell: "ask",
  filesystem: {
    read: ["."],
    write: ["."],
    deny: [
      ".env",
      ".env.*",
      "**/*secret*",
      "~/.ssh/**",
      "id_rsa",
      "id_ed25519",
      "*.pem",
      "*.key",
      "*token*",
      "*credential*"
    ]
  },
  external_communication: "block",
  credentials: "block",
  cloud_model_sensitive_context: "ask",
  browser: "block",
  browser_hosts_allow: [],
  browser_max_navigation_ms: 30_000,
  browser_max_steps_per_session: 50,
  mcp: "block",
  mcp_max_concurrent_sessions: 1,
  github: "block",
  vault: "block"
};

export function defaultConfigYaml(): string {
  return `${YAML.stringify(DEFAULT_CONFIG)}\n`;
}

export function defaultPolicyYaml(): string {
  return `${YAML.stringify(DEFAULT_POLICY)}\n`;
}
