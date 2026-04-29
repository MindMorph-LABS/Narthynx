import YAML from "yaml";

export const WORKSPACE_DIR_NAME = ".narthynx";
export const CONFIG_FILE_NAME = "config.yaml";
export const POLICY_FILE_NAME = "policy.yaml";
export const MISSIONS_DIR_NAME = "missions";

export const DEFAULT_CONFIG = {
  workspace_version: 1,
  created_by: "narthynx",
  default_policy: POLICY_FILE_NAME,
  missions_dir: MISSIONS_DIR_NAME
} as const;

export const DEFAULT_POLICY = {
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
  cloud_model_sensitive_context: "ask"
} as const;

export function defaultConfigYaml(): string {
  return `${YAML.stringify(DEFAULT_CONFIG)}\n`;
}

export function defaultPolicyYaml(): string {
  return `${YAML.stringify(DEFAULT_POLICY)}\n`;
}
