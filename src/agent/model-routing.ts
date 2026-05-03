import type { ModelRoutingConfig, ModelRoutingEndpoint } from "../config/model-routing-config";
import { ledgerFilePath, readLedgerEvents } from "../missions/ledger";
import { missionDirectory } from "../missions/store";
import type { ModelProvider, ModelTask } from "./model-provider";
import { ModelProviderError } from "./model-provider";
import { createOpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from "./providers/openai-compatible";
import { createStubModelProvider } from "./providers/stub";
import { openAiBaseUrlIsNetworkedForPolicy } from "./url-class";

export const SENSITIVE_CLOUD_TOOL_NAME = "narthynx.model.sensitive_context";

export interface MissionModelSpend {
  totalTokens: number;
  estimatedCostUsd: number;
}

export async function computeMissionModelSpend(missionLedgerPath: string): Promise<MissionModelSpend> {
  const events = await readLedgerEvents(missionLedgerPath, { allowMissing: true });
  let totalTokens = 0;
  let estimatedCostUsd = 0;

  for (const ev of events) {
    if (ev.type === "model.called" && ev.details) {
      const d = ev.details as Record<string, unknown>;
      const tt = d.totalTokens;
      if (typeof tt === "number" && Number.isFinite(tt)) {
        totalTokens += tt;
      }
    }
    if (ev.type === "cost.recorded" && ev.details) {
      const d = ev.details as Record<string, unknown>;
      const c = d.estimatedCost;
      if (typeof c === "number" && Number.isFinite(c)) {
        estimatedCostUsd += c;
      }
    }
  }

  return { totalTokens, estimatedCostUsd };
}

export interface ResolvedRouteLeg {
  endpointId: string;
  endpoint: ModelRoutingEndpoint;
}

export function resolveRouteLegsForTask(task: ModelTask, config: ModelRoutingConfig): ResolvedRouteLeg[] {
  const taskCfg = config.tasks?.[task];
  if (!taskCfg) {
    return [];
  }
  const endpoints = config.endpoints;
  const p = endpoints[taskCfg.primary];
  if (!p) {
    return [];
  }
  const legs: ResolvedRouteLeg[] = [{ endpointId: taskCfg.primary, endpoint: p }];
  if (taskCfg.fallback) {
    const f = endpoints[taskCfg.fallback];
    if (f) {
      legs.push({ endpointId: taskCfg.fallback, endpoint: f });
    }
  }
  return legs;
}

export interface BuildProviderOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function buildProviderFromEndpoint(
  endpointId: string,
  endpoint: ModelRoutingEndpoint,
  options: BuildProviderOptions
): ModelProvider {
  if (endpoint.kind === "stub") {
    return createStubModelProvider();
  }

  const apiKeyEnvName = endpoint.api_key_env ?? "NARTHYNX_OPENAI_API_KEY";
  const apiKey = options.env[apiKeyEnvName];
  if (!apiKey || apiKey.length === 0) {
    throw new ModelProviderError(
      `OpenAI-compatible endpoint "${endpointId}" requires ${apiKeyEnvName} to be set.`,
      "provider_config_missing"
    );
  }

  const isNetworked = openAiBaseUrlIsNetworkedForPolicy(endpoint.base_url);
  const o: OpenAICompatibleProviderOptions = {
    baseUrl: endpoint.base_url,
    apiKey,
    model: endpoint.model,
    isNetworked,
    timeoutMs: endpoint.timeout_ms,
    maxTokens: endpoint.max_tokens,
    temperature: endpoint.temperature,
    fetchImpl: options.fetchImpl
  };
  return createOpenAICompatibleProvider(o);
}

/** Errors after which we may try a configured fallback (single hop). */
export function isFallbackEligibleError(error: unknown): boolean {
  if (!(error instanceof ModelProviderError)) {
    return false;
  }
  return error.code === "request_failed" || error.code === "timeout" || error.code === "http_error";
}

export function providerFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): ModelProvider {
  const name = env.NARTHYNX_MODEL_PROVIDER ?? "stub";
  if (name === "stub") {
    return createStubModelProvider();
  }

  if (name === "openai-compatible") {
    const baseUrl = env.NARTHYNX_OPENAI_BASE_URL;
    const apiKey = env.NARTHYNX_OPENAI_API_KEY;
    const model = env.NARTHYNX_OPENAI_MODEL;

    if (!baseUrl || !apiKey || !model) {
      throw new ModelProviderError(
        "OpenAI-compatible provider requires NARTHYNX_OPENAI_BASE_URL, NARTHYNX_OPENAI_API_KEY, and NARTHYNX_OPENAI_MODEL.",
        "provider_config_missing"
      );
    }

    return createOpenAICompatibleProvider({
      baseUrl,
      apiKey,
      model,
      isNetworked: openAiBaseUrlIsNetworkedForPolicy(baseUrl),
      fetchImpl
    });
  }

  throw new ModelProviderError(`Unknown model provider: ${name}`, "provider_unknown");
}

export interface BudgetCheckInput {
  budgets: ModelRoutingConfig["budgets"];
  spend: MissionModelSpend;
}

/** Returns true if this call should be forced to stub (downgrade path). */
export function shouldBudgetDowngradeToStub(input: BudgetCheckInput): boolean {
  const b = input.budgets;
  if (!b) {
    return false;
  }
  if (b.on_exceed !== "downgrade_stub") {
    return false;
  }
  if (b.max_total_tokens_per_mission !== undefined && input.spend.totalTokens >= b.max_total_tokens_per_mission) {
    return true;
  }
  if (
    b.max_estimated_cost_usd_per_mission !== undefined &&
    input.spend.estimatedCostUsd >= b.max_estimated_cost_usd_per_mission
  ) {
    return true;
  }
  return false;
}

export function assertBudgetAllowsCall(input: BudgetCheckInput): void {
  const b = input.budgets;
  if (!b) {
    return;
  }
  if (b.on_exceed === "downgrade_stub") {
    return;
  }
  if (b.max_total_tokens_per_mission !== undefined && input.spend.totalTokens >= b.max_total_tokens_per_mission) {
    throw new ModelProviderError(
      `Mission model token budget exceeded (${input.spend.totalTokens} >= ${b.max_total_tokens_per_mission}).`,
      "budget_exceeded",
      { spend: input.spend, limitTokens: b.max_total_tokens_per_mission }
    );
  }
  if (
    b.max_estimated_cost_usd_per_mission !== undefined &&
    input.spend.estimatedCostUsd >= b.max_estimated_cost_usd_per_mission
  ) {
    throw new ModelProviderError(
      `Mission model cost budget exceeded (${input.spend.estimatedCostUsd} >= ${b.max_estimated_cost_usd_per_mission} USD).`,
      "budget_exceeded",
      { spend: input.spend, limitCostUsd: b.max_estimated_cost_usd_per_mission }
    );
  }
}

export async function readMissionSpendForBudget(
  missionsDir: string,
  missionId: string
): Promise<MissionModelSpend> {
  const dir = missionDirectory(missionsDir, missionId);
  return computeMissionModelSpend(ledgerFilePath(dir));
}
