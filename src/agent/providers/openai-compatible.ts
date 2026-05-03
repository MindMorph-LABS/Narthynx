import type { ModelCallRequest, ModelCallResponse, ModelProvider, ModelTask } from "../model-provider";
import { ModelProviderError } from "../model-provider";

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** When omitted, derived from baseUrl (loopback = local). */
  isNetworked?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

const TASK_SYSTEM_PROMPTS: Record<ModelTask, string> = {
  intent_classification:
    "You are Narthynx's intent classifier. Return only valid JSON. Do not include markdown fences.",
  planning:
    "You are Narthynx's model planning provider. Return only valid JSON. Do not include markdown fences.",
  file_summarization:
    "You are Narthynx's summarization helper. Return only valid JSON or plain summary text as requested. Do not include markdown fences unless the user input asks for it.",
  tool_argument_drafting:
    "You are Narthynx's tool-argument assistant. Return only valid JSON for tool arguments. Do not include markdown fences.",
  risk_classification:
    "You are Narthynx's risk classifier. Return only valid JSON. Do not include markdown fences.",
  final_report:
    "You are Narthynx's report drafting assistant. Return only valid JSON or Markdown as specified in the user message. Do not wrap in markdown fences unless asked.",
  companion_chat:
    "You are Narthynx Companion (Frontier F17). Reply helpfully without claiming consciousness or manipulating emotions. Never instruct evasion of law, medical diagnosis, or financial certainty; suggest professional help for high-stakes domains. Never propose shell commands, file writes, browser automation, MCP, vault access, or any executable tool payload — only conversational reply plus optional structured suggestions (mission goal / memory proposal). Return ONLY valid JSON matching: {\"reply\":\"string\",\"suggestMission?\":{\"title\":\"string\",\"goal\":\"string\"},\"proposeMemory?\":{\"text\":\"string\"}}. Omit optional keys when unused. Do not wrap in markdown fences."
};

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions): ModelProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const isNetworked = options.isNetworked ?? true;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const temperature = options.temperature ?? 0;
  const max_tokens = options.maxTokens ?? 4096;

  return {
    name: "openai-compatible",
    model: options.model,
    isNetworked,
    async call(request: ModelCallRequest): Promise<ModelCallResponse> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const systemContent = TASK_SYSTEM_PROMPTS[request.task] ?? TASK_SYSTEM_PROMPTS.planning;

      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`
          },
          body: JSON.stringify({
            model: options.model,
            temperature,
            max_tokens: max_tokens,
            messages: [
              {
                role: "system",
                content: systemContent
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
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new ModelProviderError(`OpenAI-compatible provider timed out after ${timeoutMs}ms.`, "timeout");
          }
          if (error instanceof Error && error.name === "AbortError") {
            throw new ModelProviderError(`OpenAI-compatible provider timed out after ${timeoutMs}ms.`, "timeout");
          }
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
            "http_error",
            { httpStatus: response.status }
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
      } finally {
        clearTimeout(timer);
      }
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
