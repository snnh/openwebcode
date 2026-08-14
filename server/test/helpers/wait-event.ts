import type { AppEvent, EventBus } from "../../src/events/event-bus.js";

interface WaitForEventOptions {
  /** 只匹配指定会话的事件 */
  sessionId?: string;
  /** 额外谓词（在 type/sessionId 过滤之后判定） */
  match?: (event: AppEvent) => boolean;
}

/** 等待 EventBus 上出现匹配事件：type 过滤，可选 sessionId 与自定义谓词。 */
export function waitForEvent(events: EventBus, type: string, options: WaitForEventOptions = {}): Promise<AppEvent> {
  return new Promise((resolve) => {
    const listener = (event: AppEvent): void => {
      if (event.type !== type) return;
      if (options.sessionId !== undefined && event.sessionId !== options.sessionId) return;
      if (options.match && !options.match(event)) return;
      events.removeListener("event", listener);
      resolve(event);
    };
    events.on("event", listener);
  });
}
