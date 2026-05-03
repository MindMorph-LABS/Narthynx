import type { SubagentProfileResolved } from "./schema";

export class SubagentBudget {
  turnsUsed = 0;
  toolCallsUsed = 0;
  modelCallsUsed = 0;

  constructor(private readonly profile: SubagentProfileResolved) {}

  canStartTurn(): boolean {
    return this.turnsUsed < this.profile.maxTurns;
  }

  consumeTurn(): boolean {
    if (!this.canStartTurn()) {
      return false;
    }
    this.turnsUsed += 1;
    return true;
  }

  canUseTool(): boolean {
    return this.toolCallsUsed < this.profile.maxToolCallsPerSession;
  }

  consumeToolCall(): boolean {
    if (!this.canUseTool()) {
      return false;
    }
    this.toolCallsUsed += 1;
    return true;
  }

  canUseModel(): boolean {
    return this.modelCallsUsed < this.profile.maxModelCallsPerSession;
  }

  consumeModelCall(): boolean {
    if (!this.canUseModel()) {
      return false;
    }
    this.modelCallsUsed += 1;
    return true;
  }

  snapshot(): { turnsUsed: number; toolCallsUsed: number; modelCallsUsed: number } {
    return {
      turnsUsed: this.turnsUsed,
      toolCallsUsed: this.toolCallsUsed,
      modelCallsUsed: this.modelCallsUsed
    };
  }
}
