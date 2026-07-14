import { EventEmitter } from "node:events";
export class EventBus extends EventEmitter {
    publish(event) {
        this.emit("event", event);
    }
}
