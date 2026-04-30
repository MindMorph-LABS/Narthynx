import type { LedgerEvent } from "../missions/ledger";
import { createMissionStore } from "../missions/store";

export interface MissionCostSummary {
  missionId: string;
  modelCallCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  currency: string;
  sensitiveContextIncluded: boolean;
  providers: Array<{
    provider: string;
    model: string;
    calls: number;
    estimatedCost: number;
  }>;
}

export function createCostService(cwd = process.cwd()) {
  const missionStore = createMissionStore(cwd);

  return {
    async summarizeMissionCost(missionId: string): Promise<MissionCostSummary> {
      await missionStore.readMission(missionId);
      const ledger = await missionStore.readMissionLedger(missionId);
      return buildMissionCostSummary(missionId, ledger);
    },

    async renderMissionCost(missionId: string): Promise<string> {
      return renderMissionCostSummary(await this.summarizeMissionCost(missionId));
    }
  };
}

export function buildMissionCostSummary(missionId: string, ledger: LedgerEvent[]): MissionCostSummary {
  const modelEvents = ledger.filter((event) => event.type === "model.called");
  const costEvents = ledger.filter((event) => event.type === "cost.recorded");
  const providerMap = new Map<string, { provider: string; model: string; calls: number; estimatedCost: number }>();

  for (const event of modelEvents) {
    const provider = stringDetail(event, "provider") ?? "unknown";
    const model = stringDetail(event, "model") ?? "unknown";
    const key = `${provider}/${model}`;
    const existing = providerMap.get(key) ?? { provider, model, calls: 0, estimatedCost: 0 };
    existing.calls += 1;
    providerMap.set(key, existing);
  }

  for (const event of costEvents) {
    const provider = stringDetail(event, "provider") ?? "unknown";
    const model = stringDetail(event, "model") ?? "unknown";
    const key = `${provider}/${model}`;
    const existing = providerMap.get(key) ?? { provider, model, calls: 0, estimatedCost: 0 };
    existing.estimatedCost += numberDetail(event, "estimatedCost") ?? 0;
    providerMap.set(key, existing);
  }

  return {
    missionId,
    modelCallCount: modelEvents.length,
    inputTokens: sum(costEvents, "inputTokens"),
    outputTokens: sum(costEvents, "outputTokens"),
    totalTokens: sum(costEvents, "totalTokens"),
    estimatedCost: sum(costEvents, "estimatedCost"),
    currency: firstString(costEvents, "currency") ?? "USD",
    sensitiveContextIncluded: modelEvents.some((event) => booleanDetail(event, "sensitiveContextIncluded") === true),
    providers: [...providerMap.values()].sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))
  };
}

export function renderMissionCostSummary(summary: MissionCostSummary): string {
  const lines = [
    `Cost for ${summary.missionId}`,
    `model calls: ${summary.modelCallCount}`,
    `input tokens: ${summary.inputTokens}`,
    `output tokens: ${summary.outputTokens}`,
    `total tokens: ${summary.totalTokens}`,
    `estimated cost: ${formatCost(summary.estimatedCost, summary.currency)}`,
    `sensitive context included: ${summary.sensitiveContextIncluded ? "yes" : "no"}`
  ];

  if (summary.providers.length === 0) {
    lines.push("providers: none");
  } else {
    lines.push("providers:");
    for (const provider of summary.providers) {
      lines.push(`  - ${provider.provider}/${provider.model}: ${provider.calls} calls, ${formatCost(provider.estimatedCost, summary.currency)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function sum(events: LedgerEvent[], key: string): number {
  return events.reduce((total, event) => total + (numberDetail(event, key) ?? 0), 0);
}

function firstString(events: LedgerEvent[], key: string): string | undefined {
  for (const event of events) {
    const value = stringDetail(event, key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function stringDetail(event: LedgerEvent, key: string): string | undefined {
  const value = event.details?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberDetail(event: LedgerEvent, key: string): number | undefined {
  const value = event.details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanDetail(event: LedgerEvent, key: string): boolean | undefined {
  const value = event.details?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function formatCost(value: number, currency: string): string {
  return `${currency} ${value.toFixed(6)}`;
}
