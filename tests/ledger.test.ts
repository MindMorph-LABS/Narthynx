import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { appendLedgerEvent, readLedgerEvents } from "../src/missions/ledger";

async function tempLedgerPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "narthynx-ledger-"));
  return path.join(dir, "ledger.jsonl");
}

describe("mission ledger", () => {
  it("appends events and reads them in order", async () => {
    const ledgerPath = await tempLedgerPath();

    const first = await appendLedgerEvent(ledgerPath, {
      missionId: "m_123e4567-e89b-12d3-a456-426614174000",
      type: "mission.created",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "Mission created"
    });
    const second = await appendLedgerEvent(ledgerPath, {
      missionId: "m_123e4567-e89b-12d3-a456-426614174000",
      type: "mission.state_changed",
      timestamp: "2026-01-01T00:01:00.000Z",
      summary: "Mission state changed",
      details: {
        from: "created",
        to: "planning"
      }
    });

    await expect(readLedgerEvents(ledgerPath)).resolves.toEqual([first, second]);
  });

  it("returns an empty list for missing ledgers when allowed", async () => {
    const ledgerPath = await tempLedgerPath();

    await expect(readLedgerEvents(`${ledgerPath}.missing`, { allowMissing: true })).resolves.toEqual([]);
  });

  it("fails with path and line number for invalid JSON", async () => {
    const ledgerPath = await tempLedgerPath();
    await writeFile(ledgerPath, "{not-json}\n", "utf8");

    await expect(readLedgerEvents(ledgerPath)).rejects.toThrow(`${ledgerPath}:1`);
  });

  it("fails with path and line number for schema-invalid events", async () => {
    const ledgerPath = await tempLedgerPath();
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        id: "bad",
        missionId: "m_123e4567-e89b-12d3-a456-426614174000",
        type: "mission.created",
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "Mission created"
      })}\n`,
      "utf8"
    );

    await expect(readLedgerEvents(ledgerPath)).rejects.toThrow(`${ledgerPath}:1`);
    await expect(readLedgerEvents(ledgerPath)).rejects.toThrow("id");
  });
});
