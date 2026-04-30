import type { ModelCallRequest, ModelCallResponse, ModelProvider } from "../model-provider";
import { ModelProviderError } from "../model-provider";

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions): ModelProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "openai-compatible",
    model: options.model,
    isNetworked: true,
    async call(request: ModelCallRequest): Promise<ModelCallResponse> {
      const started = Date.now();
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You are Narthynx's model planning provider. Return only valid JSON. Do not include markdown fences."
            },
            {
              role: "user",
              content: JSON.stringify({
                task: request.task,
                purpose: request.purpose,
                input: request.input
              })
            }
          ]
        })
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown network failure";
        throw new ModelProviderError(`OpenAI-compatible provider request failed: ${redactSecrets(message)}`, "request_failed");
      });

      const text = await response.text();
      let body: unknown;
      try {
        body = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        throw new ModelProviderError("OpenAI-compatible provider returned non-JSON response.", "invalid_response");
      }

      if (!response.ok) {
        throw new ModelProviderError(
          `OpenAI-compatible provider returned HTTP ${response.status}: ${redactSecrets(extractErrorMessage(body))}`,
          "http_error"
        );
      }

      const content = extractContent(body);
      const usage = extractUsage(body);

      return {
        provider: "openai-compatible",
        model: options.model,
        content,
        usage,
        cost: estimateOpenAICost(usage),
        latencyMs: Date.now() - started
      };
    }
  };
}

function extractContent(body: unknown): string {
  const choices = objectValue(body, "choices");
  if (!Array.isArray(choices)) {
    throw new ModelProviderError("OpenAI-compatible response is missing choices.", "invalid_response");
  }

  const first = choices[0];
  const message = objectValue(first, "message");
  const content = objectValue(message, "content");
  if (typeof content !== "string") {
    throw new ModelProviderError("OpenAI-compatible response is missing message content.", "invalid_response");
  }

  return content;
}

function extractUsage(body: unknown): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  const usage = objectValue(body, "usage");
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const promptTokens = numberValue(usage, "prompt_tokens");
  const completionTokens = numberValue(usage, "completion_tokens");
  const totalTokens = numberValue(usage, "total_tokens");

  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens
  };
}

function estimateOpenAICost(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
): { estimatedCost: number; currency: "USD" } | undefined {
  if (!usage || usage.totalTokens === undefined) {
    return undefined;
  }

  return {
    estimatedCost: 0,
    currency: "USD"
  };
}

function extractErrorMessage(body: unknown): string {
  const error = objectValue(body, "error");
  const message = objectValue(error, "message");
  return typeof message === "string" ? message : "No provider error message.";
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function numberValue(value: unknown, key: string): number | undefined {
  const candidate = objectValue(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [redacted]");
}
