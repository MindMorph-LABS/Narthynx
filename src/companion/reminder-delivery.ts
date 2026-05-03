import { appendDaemonLog } from "../daemon/log";
import type { WorkerContext } from "../daemon/worker";
import type { WorkspacePaths } from "../config/workspace";
import { peelDueCompanionReminders } from "./reminders";

/** Frontier F17 — pulls due companion reminders, notifies, emits durable event rows. */
export async function deliverDueCompanionReminders(paths: WorkspacePaths, ctx: WorkerContext): Promise<number> {
  const fired = await peelDueCompanionReminders(paths, Date.now());
  for (const r of fired) {
    await ctx.notificationSink.notify(`Reminder: ${r.message}`, "info");
    await ctx.eventBus.append({
      type: "companion.reminder.delivered",
      summary: `Reminder fired: ${r.message.slice(0, 240)}`,
      details: {
        reminderId: r.id,
        fireAt: r.fireAt,
        sessionId: r.sessionId
      }
    });
    await appendDaemonLog(paths, `companion reminder delivered id=${r.id}`);
  }
  return fired.length;
}
