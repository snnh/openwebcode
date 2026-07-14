import { EventEmitter } from "node:events";

export interface AppEvent {
  source: "server" | "core" | "agent" | "session";
  type: string;
  sessionId?: string;
  payload: unknown;
}

export class EventBus extends EventEmitter {
  publish(event: AppEvent): void {
    this.emit("event", event);
  }
}
