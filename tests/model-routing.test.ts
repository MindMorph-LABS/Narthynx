import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createModelRouter } from "../src/agent/model-router";
import { ModelProviderError } from "../src/agent/model-provider";
import { baseUrlHostIsLoopback, openAiBaseUrlIsNetworkedForPolicy } from "../src/agent/url-class";
import {
  assertBudgetAllowsCall,
  buildProviderFromEndpoint,
  computeMissionModelSpend,
  isFallbackEligibleError,
  resolveRouteLegsForTask,
  shouldBudgetDowngradeToStub
} from "../src/agent/model-routing";
import { loadModelRoutingConfig, MODEL_ROUTING_FILE_NAME } from "../src/config/model-routing-config";
import { defaultPolicyYaml } from "../src/config/defaults";
import { initWorkspace } from "../src/config/workspace";
import { createApprovalStore } from "../src/missions/approvals";
import { appendLedgerEvent, ledgerFilePath } from "../src/missions/ledger";
import { createMissionStore, missionDirectory } from "../src/missions/store";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-mr-"));
}

describe("url-class", () => {
  it("treats localhost and 127.0.0.1 as loopback", () => {
    expect(baseUrlHostIsLoopback("http://127.0.0.1:11434/v1")).toBe(true);
    expect(baseUrlHostIsLoopback("http://localhost:8080")).toBe(true);
    expect(openAiBaseUrlIsNetworkedForPolicy("http://localhost/v1")).toBe(false);
  });

  it("treats remote hosts as networked for policy", () => {
    expect(openAiBaseUrlIsNetworkedForPolicy("https://api.openai.com/v1")).toBe(true);
    expect(baseUrlHostIsLoopback("https://api.example.com")).toBe(false);
  });
});

describe("model-routing-config", () => {
  it("accepts valid task routes and endpoints", async () => {
    const dir = await tempRoot();
    const p = path.join(dir, "mr.yaml");
    await writeFile(
      p,
      `
version: 1
endpoints:
  local:
    kind: stub
  remote:
    kind: openai_compatible
    base_url: https://example.com/v1
    model: m1
tasks:
  planning:
    primary: local
    fallback: remote
`,
      "utf8"
    );
    const r = await loadModelRoutingConfig(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tasks?.planning?.primary).toBe("local");
    }
  });

  it("fails when task references missing endpoint", async () => {
    const dir = await tempRoot();
    const p = path.join(dir, "bad.yaml");
    await writeFile(
      p,
      `version: 1
endpoints:
  a:
    kind: stub
tasks:
  planning:
    primary: missing
`,
      "utf8"
    );
    const r = await loadModelRoutingConfig(p);
    expect(r.ok).toBe(false);
  });
});

describe("model routing resolution", () => {
  it("resolves YAML legs for a task", async () => {
    const dir = await tempRoot();
    const p = path.join(dir, "mr.yaml");
    await writeFile(
      p,
      `version: 1
endpoints:
  p:
    kind: stub
  f:
    kind: stub
tasks:
  planning:
    primary: p
    fallback: f
`,
      "utf8"
    );
    const r = await loadModelRoutingConfig(p);
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    const legs = resolveRouteLegsForTask("planning", r.value);
    expect(legs.map((l) => l.endpointId)).toEqual(["p", "f"]);
  });

  it("uses fallback when primary throws eligible error", async () => {
    const cwd = await tempRoot();
    await initWorkspace(cwd);
    await writeFile(
      path.join(cwd, ".narthynx", "policy.yaml"),
      defaultPolicyYaml().replace("allow_network: false", "allow_network: true"),
      "utf8"
    );
    const mr = path.join(cwd, ".narthynx", MODEL_ROUTING_FILE_NAME);
    await writeFile(
      mr,
      `version: 1
endpoints:
  bad:
    kind: openai_compatible
    base_url: https://invalid.invalid.example/v1
    model: x
  good:
    kind: stub
tasks:
  planning:
    primary: bad
    fallback: good
`,
      "utf8"
    );
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "g" });
    const fetchImpl = vi.fn(async () => {
      throw new Error("simulated primary failure");
    });
    const router = createModelRouter({
      cwd,
      env: {
        ...process.env,
        NARTHYNX_OPENAI_API_KEY: "sk-test"
      },
      fetchImpl: fetchImpl as typeof fetch
    });

    await router.call({
      missionId: mission.id,
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: false,
      input: {
        mission: {
          id: mission.id,
          title: mission.title,
          goal: mission.goal,
          successCriteria: mission.successCriteria
        }
      }
    });

    const ledger = await store.readMissionLedger(mission.id);
    const lastModel = ledger.filter((e) => e.type === "model.called").at(-1);
    const details = lastModel?.details as Record<string, unknown> | undefined;
    expect(details?.model).toBe("deterministic-local-stub");
    expect((details?.routing as Record<string, unknown>)?.usedFallback).toBe(true);
  });
});

describe("model budget helpers", () => {
  it("aggregates spend from ledger", async () => {
    const cwd = await tempRoot();
    await initWorkspace(cwd);
    const store = createMissionStore(cwd);
    const m = await store.createMission({ goal: "g" });
    const lp = ledgerFilePath(missionDirectory(path.join(cwd, ".narthynx", "missions"), m.id));
    await appendLedgerEvent(lp, {
      missionId: m.id,
      type: "model.called",
      summary: "t",
      details: { totalTokens: 100 }
    });
    await appendLedgerEvent(lp, {
      missionId: m.id,
      type: "cost.recorded",
      summary: "c",
      details: { estimatedCost: 1.5 }
    });
    const spend = await computeMissionModelSpend(lp);
    expect(spend.totalTokens).toBe(100);
    expect(spend.estimatedCostUsd).toBe(1.5);
  });

  it("throws on fail_closed budget exceed", () => {
    expect(() =>
      assertBudgetAllowsCall({
        budgets: {
          max_total_tokens_per_mission: 10,
          on_exceed: "fail_closed" as const
        },
        spend: { totalTokens: 10, estimatedCostUsd: 0 }
      })
    ).toThrow(ModelProviderError);
  });

  it("downgrade_stub skips assert and flags shouldBudgetDowngradeToStub", () => {
    expect(
      shouldBudgetDowngradeToStub({
        budgets: {
          max_total_tokens_per_mission: 5,
          on_exceed: "downgrade_stub" as const
        },
        spend: { totalTokens: 5, estimatedCostUsd: 0 }
      })
    ).toBe(true);
    expect(() =>
      assertBudgetAllowsCall({
        budgets: {
          max_total_tokens_per_mission: 5,
          on_exceed: "downgrade_stub" as const
        },
        spend: { totalTokens: 5, estimatedCostUsd: 0 }
      })
    ).not.toThrow();
  });
});

describe("isFallbackEligibleError", () => {
  it("matches timeout and http_error codes", () => {
    expect(isFallbackEligibleError(new ModelProviderError("x", "timeout"))).toBe(true);
    expect(isFallbackEligibleError(new ModelProviderError("x", "http_error"))).toBe(true);
    expect(isFallbackEligibleError(new ModelProviderError("x", "invalid_response"))).toBe(false);
  });
});

describe("sensitive consent execution", () => {
  it("succeeds after approval and marks approval executed", async () => {
    const cwd = await tempRoot();
    await initWorkspace(cwd);
    await writeFile(
      path.join(cwd, ".narthynx", "policy.yaml"),
      defaultPolicyYaml().replace("allow_network: false", "allow_network: true"),
      "utf8"
    );

    const store = createMissionStore(cwd);
    const approvalStore = createApprovalStore(cwd);
    const mission = await store.createMission({ goal: "g" });

    const provider = {
      name: "fake",
      model: "fake-model",
      isNetworked: true,
      async call() {
        return {
          provider: "fake",
          model: "fake-model",
          content: "{}",
          latencyMs: 1
        };
      }
    };

    const router = createModelRouter({ cwd, provider, approvalStore });

    const p = router.call({
      missionId: mission.id,
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: true,
      input: {}
    });
    await expect(p).rejects.toMatchObject({ code: "sensitive_requires_approval" });

    const pending = await approvalStore.listPendingApprovals();
    const id = pending[0]!.id;
    await approvalStore.decideApproval(id, "approved");

    await router.call({
      missionId: mission.id,
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: true,
      input: {}
    });

    const updated = await approvalStore.getApproval(id);
    expect(updated.executedAt).toBeDefined();
  });
});

describe("buildProviderFromEndpoint", () => {
  it("marks loopback openai as non-networked", () => {
    const p = buildProviderFromEndpoint(
      "L",
      {
        kind: "openai_compatible",
        base_url: "http://127.0.0.1:11434/v1",
        model: "m"
      },
      { env: { NARTHYNX_OPENAI_API_KEY: "k" } }
    );
    expect(p.isNetworked).toBe(false);
  });
});
