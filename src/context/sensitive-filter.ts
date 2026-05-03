import { isSensitiveContextPath } from "../cli/shortcuts";
import { workspaceNoteLooksSensitive } from "../cli/workspace-notes";
import type { WorkspacePolicy } from "../config/load";
import type { ContextItemKind } from "./types";

function classifyWorkspaceText(text: string): "none" | "low" | "sensitive" {
  if (workspaceNoteLooksSensitive(text)) {
    return "sensitive";
  }
  return "none";
}

export function classifyItemSensitivity(input: {
  kind: ContextItemKind;
  label: string;
  text: string;
  memorySensitivity?: "none" | "low" | "sensitive";
}): "none" | "low" | "sensitive" {
  if (input.kind === "memory" && input.memorySensitivity) {
    return input.memorySensitivity;
  }

  const textClass = classifyWorkspaceText(input.text);
  const pathSens =
    input.kind === "file" || input.kind === "workspace_note" ? isSensitiveContextPath(input.label) : false;

  if (textClass === "sensitive" || pathSens) {
    return "sensitive";
  }
  return textClass;
}

/** Advisory routing hint — enforcement remains in model-router consent. */
export function routingHintForSensitivity(
  sensitivity: "none" | "low" | "sensitive",
  policy: WorkspacePolicy
): "eligible_for_cloud" | "sensitive_prefs_local" {
  if (sensitivity === "sensitive") {
    return "sensitive_prefs_local";
  }
  const mode = policy.cloud_model_sensitive_context;
  if (mode === "allow") {
    return "eligible_for_cloud";
  }
  if (mode === "ask") {
    return "eligible_for_cloud";
  }
  return "sensitive_prefs_local";
}
