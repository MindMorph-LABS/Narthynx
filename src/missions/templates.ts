import type { CreateMissionInput, RiskLevel } from "./schema";

export interface MissionTemplate {
  name: string;
  title: string;
  description: string;
  defaultGoal: string;
  successCriteria: string[];
  riskProfile: {
    level: RiskLevel;
    reasons: string[];
  };
}

export const builtInMissionTemplates: MissionTemplate[] = [
  {
    name: "launch-readiness-review",
    title: "Launch readiness review",
    description: "Inspect local project readiness and produce a launch checklist-style mission report.",
    defaultGoal: "Review this repository for launch readiness and summarize gaps, risks, and next actions.",
    successCriteria: [
      "Local project structure is inspected.",
      "Relevant readiness signals are captured in the mission ledger.",
      "A durable report summarizes launch gaps, risks, and next actions."
    ],
    riskProfile: {
      level: "low",
      reasons: ["Template starts with read-only inspection and approval-gated artifacts."]
    }
  },
  {
    name: "bug-investigation",
    title: "Bug investigation",
    description: "Track a local bug investigation with durable plan, ledger, report, and replay.",
    defaultGoal: "Investigate a local bug report and produce a clear summary of findings, evidence, and next steps.",
    successCriteria: [
      "The reported behavior is captured as a mission goal.",
      "Read-only local evidence is gathered where available.",
      "The final report separates findings, limitations, and recommended fixes."
    ],
    riskProfile: {
      level: "low",
      reasons: ["Bug investigation begins with local read-only inspection."]
    }
  },
  {
    name: "research-brief",
    title: "Research brief",
    description: "Create a local-first research brief from mission notes and safe attached context.",
    defaultGoal: "Prepare a concise research brief from safe local context and mission notes.",
    successCriteria: [
      "Research question and constraints are captured.",
      "Safe context is summarized without reading credentials.",
      "A report lists conclusions, caveats, and follow-up questions."
    ],
    riskProfile: {
      level: "low",
      reasons: ["Research brief templates do not require writes outside mission artifacts."]
    }
  },
  {
    name: "folder-organizer",
    title: "Folder organizer",
    description: "Plan a safe folder organization mission without performing arbitrary filesystem writes.",
    defaultGoal: "Inspect a folder and propose an organization plan without moving or deleting files.",
    successCriteria: [
      "Folder contents are inspected read-only.",
      "Potential organization actions are proposed, not executed silently.",
      "Any future writes remain approval-gated."
    ],
    riskProfile: {
      level: "medium",
      reasons: ["Folder organization may lead to local writes, so actions must remain approval-gated."]
    }
  },
  {
    name: "deployment-failure-triage",
    title: "Deployment failure triage",
    description: "Capture local deployment failure context and produce a triage report.",
    defaultGoal: "Triage a deployment failure using safe local repository context and produce next actions.",
    successCriteria: [
      "Failure symptoms and available local evidence are captured.",
      "Relevant project files or command outputs are referenced only when safe.",
      "The report identifies likely causes, limits, and next actions."
    ],
    riskProfile: {
      level: "medium",
      reasons: ["Deployment triage may involve shell or network in later phases; Phase 15 remains local and approval-gated."]
    }
  }
];

export function listMissionTemplates(): MissionTemplate[] {
  return [...builtInMissionTemplates].sort((left, right) => left.name.localeCompare(right.name));
}

export function getMissionTemplate(name: string): MissionTemplate {
  const template = builtInMissionTemplates.find((candidate) => candidate.name === name);
  if (!template) {
    throw new Error(`Unknown mission template: ${name}`);
  }

  return template;
}

export function createMissionInputFromTemplate(name: string, goal?: string): CreateMissionInput {
  const template = getMissionTemplate(name);
  return {
    goal: goal?.trim() || template.defaultGoal,
    title: template.title,
    successCriteria: template.successCriteria,
    riskProfile: template.riskProfile,
    templateName: template.name
  };
}
