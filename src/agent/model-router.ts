import { loadWorkspacePolicy, type WorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { missionDirectory } from "../missions/store";
import type { ModelCallRequest, ModelCallResponse, ModelProvider } from "./model-provider";
import { ModelProviderError, modelCallRequestSchema, modelCallResponseSchema, summarizeUsage } from "./model-provider";
import { createOpenAICompatibleProvider } from "./providers/openai-compatible";
import { createStubModelProvider } from "./providers/stub";

export interface ModelRouterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  provider?: ModelProvider;
}

export interface ModelRouter {
  call(request: ModelCallRequest): Promise<ModelCallResponse>;
  describeProvider(): string;
}

export function createModelRouter(options: ModelRouterOptions = {}): ModelRouter {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  return {
    async call(request) {
      const parsedRequest = modelCallRequestSchema.parse(request);
      const paths = resolveWorkspacePaths(cwd);
      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        throw new ModelProviderError(`policy.yaml invalid: ${policy.message}`, "policy_invalid");
      }

      const provider = options.provider ?? providerFromEnv(env);
      enforcePolicy(provider, parsedRequest.sensitiveContextIncluded, policy.value);
      const response = modelCallResponseSchema.parse(await provider.call(parsedRequest));

      await appendModelLedgerEvents({
        missionId: parsedRequest.missionId,
        ledgerPath: ledgerFilePath(missionDirectory(paths.missionsDir, parsedRequest.missionId)),
        request: parsedRequest,
        response
      });

      return response;
    },

    describeProvider() {
      const provider = options.provider ?? providerFromEnv(env);
      return `${provider.name}/${provider.model}`;
    }
  };
}

function providerFromEnv(env: NodeJS.ProcessEnv): ModelProvider {
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

    return createOpenAICompatibleProvider({ baseUrl, apiKey, model });
  }

  throw new ModelProviderError(`Unknown model provider: ${name}`, "provider_unknown");
}

function enforcePolicy(provider: ModelProvider, sensitiveContextIncluded: boolean, policy: WorkspacePolicy): void {
  if (provider.isNetworked && !policy.allow_network) {
    throw new ModelProviderError(
      "Cloud model provider is blocked because policy allow_network is false. Use the stub provider or update policy.yaml.",
      "network_blocked"
    );
  }

  if (!provider.isNetworked || !sensitiveContextIncluded) {
    return;
  }

  if (policy.cloud_model_sensitive_context === "block") {
    throw new ModelProviderError("Sensitive context is blocked by policy cloud_model_sensitive_context: block.", "sensitive_blocked");
  }

  if (policy.cloud_model_sensitive_context === "ask") {
    throw new ModelProviderError(
      "Sensitive context requires a typed model-context approval flow, which is not implemented in Phase 12.",
      "sensitive_requires_approval"
    );
  }
}

async function appendModelLedgerEvents(input: {
  missionId: string;
  ledgerPath: string;
  request: ModelCallRequest;
  response: ModelCallResponse;
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
