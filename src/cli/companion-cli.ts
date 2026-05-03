import { createInterface } from "node:readline/promises";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";

import { doctorWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { loadWorkspacePolicy } from "../config/load";
import { createApprovalStore } from "../missions/approvals";
import { runCompanionChatTurn } from "../companion/chat";

interface CompanionStandaloneIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

export async function runStandaloneCompanionCli(
  io: CompanionStandaloneIo,
  cwd: string,
  sessionId: string,
  options?: { singleMessage?: string }
): Promise<number> {
  const doc = await doctorWorkspace(cwd);
  if (!doc.ok) {
    io.writeErr("Workspace is unhealthy. Run: narthynx init\n");
    return 1;
  }

  const paths = resolveWorkspacePaths(cwd);
  const policy = await loadWorkspacePolicy(paths.policyFile);
  if (!policy.ok) {
    io.writeErr(`policy.yaml invalid: ${policy.message}\n`);
    return 1;
  }
  if (policy.value.companion_mode === "off") {
    io.writeErr('Companion is disabled (policy companion_mode: off).\n');
    return 1;
  }

  const approvalStore = createApprovalStore(cwd);
  const sid = sessionId.trim().length > 0 ? sessionId : "default";

  if (options?.singleMessage !== undefined) {
    const turn = await runCompanionChatTurn({
      cwd,
      sessionId: sid,
      userMessage: options.singleMessage,
      approvalStore
    });
    io.writeOut(turn.assistantText + "\n");
    return 0;
  }

  if (!stdinStream.isTTY || !stdoutStream.isTTY) {
    io.writeErr("Interactive companion requires a TTY. Use: narthynx chat -m \"…\"\n");
    return 1;
  }

  io.writeOut("Narthynx companion (Frontier F17). Type /exit to leave.\n");

  const rl = createInterface({
    input: stdinStream,
    output: stdoutStream
  });

  try {
    while (true) {
      const line = (await rl.question("narthynx cmp ❯ ")).trim();
      if (line.length === 0) {
        continue;
      }
      if (line === "/exit" || line === "/quit") {
        io.writeOut("Goodbye.\n");
        return 0;
      }
      try {
        const turn = await runCompanionChatTurn({
          cwd,
          sessionId: sid,
          userMessage: line,
          approvalStore
        });
        io.writeOut(turn.assistantText + "\n\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        io.writeErr(msg + "\n");
      }
    }
  } finally {
    rl.close();
  }
}
