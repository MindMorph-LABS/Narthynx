import { loadModelRoutingConfig, type ModelRoutingConfig } from "../config/model-routing-config";
import { loadWorkspacePolicy, type WorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import type { ApprovalStore } from "../missions/approvals";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { missionDirectory } from "../missions/store";
import type { ModelCallRequest, ModelCallResponse, ModelProvider } from "./model-provider";
import { ModelProviderError, modelCallRequestSchema, modelCallResponseSchema, summarizeUsage } from "./model-provider";
import {
  SENSITIVE_CLOUD_TOOL_NAME,
  assertBudgetAllowsCall,
  buildProviderFromEndpoint,
  isFallbackEligibleError,
  providerFromEnv,
  readMissionSpendForBudget,
  resolveRouteLegsForTask,
  shouldBudgetDowngradeToStub,
  type ResolvedRouteLeg
} from "./model-routing";
import { createStubModelProvider } from "./providers/stub";

export interface ModelRouterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** When set, skips YAML/env routing (tests). */
  provider?: ModelProvider;
  approvalStore?: ApprovalStore;
  fetchImpl?: typeof fetch;
}

export interface ModelRouter {
  call(request: ModelCallRequest): Promise<ModelCallResponse>;
  describeProvider(): string;
}

type RoutingLeg =
  | { kind: "injected" }
  | { kind: "env" }
  | { kind: "yaml"; endpointId: string; endpoint: ResolvedRouteLeg["endpoint"] };

export function createModelRouter(options: ModelRouterOptions = {}): ModelRouter {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl;

  let describeSnapshot = "stub/deterministic-local-stub";

  return {
    async call(request) {
      const parsedRequest = modelCallRequestSchema.parse(request);
      const paths = resolveWorkspacePaths(cwd);
      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        throw new ModelProviderError(`policy.yaml invalid: ${policy.message}`, "policy_invalid");
      }

      const routingLoad = await loadModelRoutingConfig(paths.modelRoutingFile);
      if (!routingLoad.ok) {
        throw new ModelProviderError(`model-routing.yaml invalid: ${routingLoad.message}`, "routing_config_invalid");
      }
      const routingConfig = routingLoad.value;

      const spend = await readMissionSpendForBudget(paths.missionsDir, parsedRequest.missionId);
      const budgetCtx = { budgets: routingConfig.budgets, spend };

      const routingMeta: Record<string, unknown> = {
        task: parsedRequest.task,
        sensitiveContextIncluded: parsedRequest.sensitiveContextIncluded
      };

      const legs = resolveRoutingLegs({
        injected: Boolean(options.provider),
        budgetDowngrade: shouldBudgetDowngradeToStub(budgetCtx),
        task: parsedRequest.task,
        routingConfig
      });

      if (!shouldBudgetDowngradeToStub(budgetCtx)) {
        assertBudgetAllowsCall(budgetCtx);
      } else {
        routingMeta.budgetDowngrade = true;
      }

      if (options.provider) {
        describeSnapshot = `${options.provider.name}/${options.provider.model}`;
      }

      const primaryEndpointLabel =
        legs[0]?.kind === "yaml"
          ? legs[0].endpointId
          : legs[0]?.kind === "env"
            ? "env:default"
            : "injected:test";

      let lastError: unknown;
      let consentApprovalId: string | undefined;

      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i]!;
        let provider: ModelProvider;

        try {
          if (leg.kind === "injected") {
            provider = options.provider!;
          } else if (leg.kind === "env") {
            provider = providerFromEnv(env, fetchImpl);
          } else if (leg.endpoint.kind === "stub" && leg.endpointId.startsWith("budget:")) {
            provider = createStubModelProvider();
          } else {
            provider = buildProviderFromEndpoint(leg.endpointId, leg.endpoint, { env, fetchImpl });
          }
        } catch (error) {
          lastError = error;
          if (i < legs.length - 1 && isFallbackEligibleError(error)) {
            continue;
          }
          throw error;
        }

        describeSnapshot = `${provider.name}/${provider.model}`;

        const consent = await ensureSensitiveCloudConsent({
          approvalStore: options.approvalStore,
          missionId: parsedRequest.missionId,
          task: parsedRequest.task,
          purpose: parsedRequest.purpose,
          sensitiveContextIncluded: parsedRequest.sensitiveContextIncluded,
          provider,
          policy: policy.value,
          packSummary: extractPackSummary(parsedRequest.input)
        });
        if (consent.approvalId) {
          consentApprovalId = consent.approvalId;
        }

        enforcePolicy(provider, parsedRequest.sensitiveContextIncluded, policy.value, consent.verified);

        try {
          const response = modelCallResponseSchema.parse(await provider.call(parsedRequest));
          const usedFallback = i > 0;
          Object.assign(routingMeta, {
            primaryEndpointId: primaryEndpointLabel,
            usedEndpointId:
              leg.kind === "yaml" ? leg.endpointId : leg.kind === "env" ? "env:default" : "injected:test",
            usedFallback,
            consentApprovalId: consentApprovalId ?? consent.approvalId
          });

          if (consentApprovalId && options.approvalStore) {
            await options.approvalStore.markApprovalExecuted(consentApprovalId);
          }

          await appendModelLedgerEvents({
            missionId: parsedRequest.missionId,
            ledgerPath: ledgerFilePath(missionDirectory(paths.missionsDir, parsedRequest.missionId)),
            request: parsedRequest,
            response,
            routing: { ...routingMeta }
          });

          return response;
        } catch (error) {
          lastError = error;
          if (i < legs.length - 1 && isFallbackEligibleError(error)) {
            continue;
          }
          throw error;
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },

    describeProvider() {
      return describeSnapshot;
    }
  };
}

function resolveRoutingLegs(input: {
  injected: boolean;
  budgetDowngrade: boolean;
  task: ModelCallRequest["task"];
  routingConfig: ModelRoutingConfig;
}): RoutingLeg[] {
  if (input.injected) {
    return [{ kind: "injected" }];
  }
  if (input.budgetDowngrade) {
    return [{ kind: "yaml", endpointId: "budget:stub", endpoint: { kind: "stub" } }];
  }

  const yamlLegs = resolveRouteLegsForTask(input.task, input.routingConfig);
  if (yamlLegs.length > 0) {
    return yamlLegs.map((leg) => ({ kind: "yaml" as const, endpointId: leg.endpointId, endpoint: leg.endpoint }));
  }

  return [{ kind: "env" }];
}

function extractPackSummary(input: unknown): { bytes?: number; estimatedTokens?: number; includedCount?: number } | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const pack = (input as Record<string, unknown>).modelContextPack as Record<string, unknown> | undefined;
  if (!pack || typeof pack !== "object") {
    return undefined;
  }
  const totals = pack.totals as Record<string, unknown> | undefined;
  if (!totals || typeof totals !== "object") {
    return undefined;
  }
  return {
    bytes: typeof totals.bytes === "number" ? totals.bytes : undefined,
    estimatedTokens: typeof totals.estimatedTokens === "number" ? totals.estimatedTokens : undefined,
    includedCount: typeof totals.includedCount === "number" ? totals.includedCount : undefined
  };
}

async function ensureSensitiveCloudConsent(input: {
  approvalStore?: ApprovalStore;
  missionId: string;
  task: ModelCallRequest["task"];
  purpose: string;
  sensitiveContextIncluded: boolean;
  provider: ModelProvider;
  policy: WorkspacePolicy;
  packSummary?: { bytes?: number; estimatedTokens?: number; includedCount?: number };
}): Promise<{ verified: boolean; approvalId?: string }> {
  if (!input.provider.isNetworked || !input.sensitiveContextIncluded) {
    return { verified: true };
  }

  if (input.policy.cloud_model_sensitive_context === "block") {
    return { verified: false };
  }

  if (input.policy.cloud_model_sensitive_context === "allow") {
    return { verified: true };
  }

  if (input.policy.cloud_model_sensitive_context !== "ask") {
    return { verified: true };
  }

  if (!input.approvalStore) {
    throw new ModelProviderError(
      "cloud_model_sensitive_context is ask but no approval store was configured for the model router.",
      "sensitive_requires_approval",
      { needsApprovalStore: true }
    );
  }

  const existing = await findReusableSensitiveConsent(input.approvalStore, input.missionId, input.task);
  if (existing) {
    return { verified: true, approvalId: existing.id };
  }

  const approval = await input.approvalStore.createApproval({
    missionId: input.missionId,
    toolName: SENSITIVE_CLOUD_TOOL_NAME,
    toolInput: {
      task: input.task,
      purpose: input.purpose,
      packSummary: input.packSummary
    },
    riskLevel: "high",
    sideEffect: "network",
    reason: "Sensitive mission context would be sent to a networked model provider."
  });

  throw new ModelProviderError(
    `Approval required before sending sensitive context to a cloud model (approval ${approval.id}). Approve with: narthynx approve ${approval.id}`,
    "sensitive_requires_approval",
    { approvalId: approval.id }
  );
}

async function findReusableSensitiveConsent(store: ApprovalStore, missionId: string, task: string) {
  const list = await store.listMissionApprovals(missionId, { allowMissing: true });
  const candidates = list.filter((a) => {
    if (a.toolName !== SENSITIVE_CLOUD_TOOL_NAME || a.status !== "approved" || a.executedAt) {
      return false;
    }
    const ti = a.toolInput as Record<string, unknown> | null;
    return ti !== null && typeof ti === "object" && ti.task === task;
  });
  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates[0];
}

function enforcePolicy(
  provider: ModelProvider,
  sensitiveContextIncluded: boolean,
  policy: WorkspacePolicy,
  sensitiveConsentVerified: boolean
): void {
  if (provider.isNetworked && !policy.allow_network) {
    throw new ModelProviderError(
      "Cloud model provider is blocked because policy allow_network is false. Use the stub provider, a loopback OpenAI-compatible endpoint, or update policy.yaml.",
      "network_blocked"
    );
  }

  if (!provider.isNetworked || !sensitiveContextIncluded) {
    return;
  }

  if (policy.cloud_model_sensitive_context === "block") {
    throw new ModelProviderError("Sensitive context is blocked by policy cloud_model_sensitive_context: block.", "sensitive_blocked");
  }

  if (policy.cloud_model_sensitive_context === "ask" && !sensitiveConsentVerified) {
    throw new ModelProviderError(
      "Sensitive context to a networked model requires an approved consent (cloud_model_sensitive_context: ask).",
      "sensitive_requires_approval"
    );
  }
}

async function appendModelLedgerEvents(input: {
  missionId: string;
  ledgerPath: string;
  request: ModelCallRequest;
  response: ModelCallResponse;
  routing: Record<string, unknown>;
}): Promise<void> {
  const usage = summarizeUsage(input.response.usage);
  await appendLedgerEvent(input.ledgerPath, {
    missionId: input.missionId,
    type: "model.called",
    summary: `Model called: ${input.response.provider}/${input.response.model} for ${input.request.purpose}`,
    details: {
      provider: input.response.provider,
      model: input.response.model,
      purpose: input.request.purpose,
      task: input.request.task,
      latencyMs: input.response.latencyMs,
      sensitiveContextIncluded: input.request.sensitiveContextIncluded,
      routing: input.routing,
      ...usage
    }
  });

  await appendLedgerEvent(input.ledgerPath, {
    missionId: input.missionId,
    type: "cost.recorded",
    summary: `Cost recorded for ${input.response.provider}/${input.response.model}`,
    details: {
      provider: input.response.provider,
      model: input.response.model,
      purpose: input.request.purpose,
      task: input.request.task,
      estimatedCost: input.response.cost?.estimatedCost,
      currency: input.response.cost?.currency ?? "USD",
      ...usage
    }
  });
}
