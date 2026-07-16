import { EventEmitter } from "node:events";
export class EventBus extends EventEmitter {
    historyLimit;
    sequence = 0;
    history = [];
    constructor(historyLimit = 1_000) {
        super();
        this.historyLimit = historyLimit;
    }
    publish(input) {
        const event = {
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
    replay(after, sessionId) {
        const oldest = this.history[0]?.seq ?? this.sequence + 1;
        const requiresResync = after > 0 && after < oldest - 1;
        const events = requiresResync
            ? []
            : this.history.filter((event) => event.seq > after && (!sessionId || !event.sessionId || event.sessionId === sessionId));
        return { events, requiresResync, latestSeq: this.sequence };
    }
    latestSeq() {
        return this.sequence;
    }
}
