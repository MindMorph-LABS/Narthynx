export type NotificationLevel = "info" | "warn" | "error";

export interface NotificationSink {
  notify(message: string, level?: NotificationLevel): Promise<void>;
}

export function createNoopNotificationSink(): NotificationSink {
  return {
    async notify() {
      /* intentional no-op */
    }
  };
}

export function createLogNotificationSink(log: (line: string) => void): NotificationSink {
  return {
    async notify(message, level = "info") {
      log(`[notify:${level}] ${message}`);
    }
  };
}
