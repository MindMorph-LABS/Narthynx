import { createMissionContextService } from "../missions/context";
import { createMissionStore } from "../missions/store";
import type { Renderer } from "./renderer";
import type { InteractiveSessionState } from "./session";

export async function handleNaturalLanguageInstruction(input: {
  text: string;
  session: InteractiveSessionState;
  renderer: Renderer;
}): Promise<void> {
  const { text, session, renderer } = input;
  const missionStore = createMissionStore(session.cwd);
  const contextService = createMissionContextService(session.cwd);

  if (!session.currentMissionId) {
    const mission = await missionStore.createMission({ goal: text });
    session.currentMissionId = mission.id;
    renderer.info("Mission created from your goal.");
    renderer.missionSummary(mission);
    const graph = await missionStore.readMissionPlanGraph(mission.id);
    const lines = graph.nodes.map((node, index) => `${index + 1}. [${node.type}] ${node.title} - ${node.status}`);
    renderer.plan(mission.id, lines, "");
    renderer.graph(graph);
    renderer.info("Use /run to execute the mission executor, or /help for commands.");
    renderer.info("Natural language only updates mission records; tools and the executor run only after approvals or /run.");
    return;
  }

  const missionId = session.currentMissionId;
  await contextService.addNote(missionId, text);
  renderer.info(`Instruction recorded on mission ${missionId}.`);
  const graph = await missionStore.ensureMissionPlanGraph(missionId);
  const lines = graph.nodes.map((node, index) => `${index + 1}. [${node.type}] ${node.title} - ${node.status}`);
  renderer.plan(missionId, lines, "");
  renderer.graph(graph);
  renderer.info("Run /run to continue the mission executor with this context.");
  renderer.info("Natural language only updates mission records; tools and the executor run only after approvals or /run.");
}
