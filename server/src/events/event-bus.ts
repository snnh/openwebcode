import { EventEmitter } from "node:events";

export interface AppEventInput {
  source: "server" | "core" | "agent" | "session";
  type: string;
  sessionId?: string;
  payload: unknown;
}

export interface AppEvent extends AppEventInput {
  seq: number;
  createdAt: string;
}

export interface ReplayResult {
  events: AppEvent[];
  requiresResync: boolean;
  latestSeq: number;
}

export class EventBus extends EventEmitter {
  private sequence = 0;
  private readonly history: AppEvent[] = [];

  constructor(private readonly historyLimit = 1_000) {
    super();
  }

  publish(input: AppEventInput): AppEvent {
    const event: AppEvent = {
      ...input,
      seq: ++this.sequence,
      createdAt: new Date().toISOString(),
    };
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    this.emit("event", event);
    return event;
  }

  replay(after: number, sessionId?: string): ReplayResult {
    const oldest = this.history[0]?.seq ?? this.sequence + 1;
    const requiresResync = after > 0 && after < oldest - 1;
    const events = requiresResync
      ? []
      : this.history.filter((event) =>
          event.seq > after && (!sessionId || !event.sessionId || event.sessionId === sessionId));
    return { events, requiresResync, latestSeq: this.sequence };
  }

  latestSeq(): number {
    return this.sequence;
  }
}
