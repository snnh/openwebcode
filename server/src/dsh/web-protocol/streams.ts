/**
 * dsh wire 端点表（M4）：unary 派发 + 逻辑流端点（`$events` / `session/control` / `workspace/follow`）。
 *
 * 与 owc 的耦合集中在 {@link DshWireDeps}：审批/提问的应答由调用方注入（翻译层不直接持有 AgentRunner）。
 */
import type { AppEvent, EventBus } from "../../events/event-bus.js";
import type { DshPluginInfo } from "../loader.js";
import type { DshMuxEndpointHandler, DshStreamHandle } from "./mux.js";
import { DshEventStream, parseEventResult, type DshEventResult, type DshWaterfallOutcome } from "./events.js";
import { projectPluginInventory } from "./plugin-inventory.js";
import {
  projectSessionAttachment,
  projectSessionCancel,
  projectSessionFollowSnapshot,
  projectSessionPage,
  projectSessionControlBaseline,
  projectSessionCreate,
  projectSessionList,
  projectSessionPrompt,
  projectSessionUpdateQueue,
  projectWorkspaceBaseline,
  sessionRecordsSince,
  type DshProjected,
  type DshProjectionDeps,
} from "./session-projection.js";
import type { DshModelSelection } from "./models.js";
import { DSH_EVENTS_STREAM, wireError } from "./wire.js";

/** 翻译层依赖（owc 侧能力的窄接口）。 */
export interface DshWireDeps {
  projection: DshProjectionDeps;
  events: EventBus;
  /** dsh ready 帧的 host.home（仅用于路径缩写展示）。 */
  home: string;
  /**
   * 模型面（`session/modelCatalog` / `session/selectModel`）：缺省时两个端点不下发
   * （客户端按 `gateway/method-unavailable` 如实报未实现）。
   */
  models?: {
    catalog(): Record<string, unknown>;
    select(args: Record<string, unknown>): Promise<DshProjected<{ selected: DshModelSelection }>>;
  };
  /** dsh 插件清单投影（`pluginInventory/list`）；缺省时该端点不下发。 */
  pluginInventory?: () => readonly DshPluginInfo[];
  /** 应答 owc 待审批（decision: allow 时会恢复工具执行）。 */
  respondPermission(sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string): Promise<void>;
  /** 应答 owc 待回答提问。 */
  respondInteraction(sessionId: string, requestId: string, answer: unknown): Promise<void>;
  logger: { warn(message: string): void };
}

/** unary 处理器签名（args 为信封里的命名参数对象）。 */
export type DshUnaryHandler = (args: Record<string, unknown>) => Promise<DshProjected<unknown>>;

/** 会话内投影（summary/control 基线共用）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** unary 端点表（未列入的端点由 server 回 `gateway/method-unavailable`）。 */
export function buildUnaryHandlers(deps: DshWireDeps): Map<string, DshUnaryHandler> {
  const handlers = new Map<string, DshUnaryHandler>();
  handlers.set("session/list", () => projectSessionList(deps.projection));
  handlers.set("session/create", (args) => projectSessionCreate(deps.projection, args));
  handlers.set("session/prompt", (args) => projectSessionPrompt(deps.projection, args));
  handlers.set("session/cancel", (args) => projectSessionCancel(deps.projection, args));
  handlers.set("session/updateQueue", (args) => projectSessionUpdateQueue(deps.projection, args));
  handlers.set("session/attachment", (args) => projectSessionAttachment(deps.projection, args));
  handlers.set("session/page", (args) => projectSessionPage(deps.projection, args));
  const models = deps.models;
  if (models !== undefined) {
    handlers.set("session/modelCatalog", () => Promise.resolve({ value: models.catalog() }));
    handlers.set("session/selectModel", (args) => models.select(args));
  }
  const inventory = deps.pluginInventory;
  if (inventory !== undefined) {
    handlers.set("pluginInventory/list", () => Promise.resolve({ value: projectPluginInventory(inventory()) }));
  }
  return handlers;
}

/**
 * `$events` 连接代桥：持有 clientId → 连接代映射（`$events/result` 需要按 clientId 归位），
 * 并把 owc 事件翻译成 dsh 转发事件（emit / waterfall）。
 */
export class DshEventBridge {
  private readonly clients = new Map<string, DshEventStream>();
  /** 挂起 waterfall 的定位索引：`<sessionId>\u0000<owcRequestId>` → 所属连接代与 dsh eventId。 */
  private readonly pendingBySource = new Map<string, { clientId: string; eventId: string }>();

  constructor(private readonly deps: DshWireDeps) {}

  /** 当前活跃连接代数（诊断/测试用）。 */
  get clientCount(): number {
    return this.clients.size;
  }

  /** `$events` 端点实现：建流 → 注册 → 订阅 owc 事件 → 连接断开时清理。 */
  open(handle: DshStreamHandle): void {
    const stream = new DshEventStream(
      this.deps.home,
      (frame) => handle.send(frame),
      (message) => this.deps.logger.warn(`dsh $events：${message}`),
    );
    this.clients.set(stream.clientId, stream);
    const unsubscribe = this.subscribe(stream);
    handle.onCancel(() => {
      unsubscribe();
      this.clients.delete(stream.clientId);
      for (const [key, entry] of [...this.pendingBySource]) {
        if (entry.clientId === stream.clientId) this.pendingBySource.delete(key);
      }
      stream.dispose();
    });
    stream.start();
  }

  /** `$events/result`：把客户端应答归位到挂起请求。 */
  async resolveResult(args: Record<string, unknown>): Promise<DshProjected<Record<string, never>>> {
    const parsed = parseEventResult(args);
    if ("error" in parsed) return { error: wireError("gateway/arguments-invalid", parsed.error) };
    const result: DshEventResult = parsed.result;
    const stream = this.clients.get(result.clientId);
    if (stream === undefined) return { error: wireError("gateway/context-not-found", "连接代不存在（clientId 未注册）", { clientId: result.clientId }) };
    this.clearPending(result.eventId);
    stream.resolveResult(result);
    return { value: {} };
  }

  /** owc 事件订阅（返回退订函数）。 */
  private subscribe(stream: DshEventStream): () => void {
    const listener = (event: AppEvent): void => {
      try {
        this.forward(stream, event);
      } catch (error) {
        this.deps.logger.warn(`dsh 事件转发失败（${event.type}）：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    this.deps.events.on("event", listener);
    return () => this.deps.events.off("event", listener);
  }

  /** 单事件映射表（v1：会话状态/审批/提问；其余 owc 事件不外泄给 dsh UI）。 */
  private forward(stream: DshEventStream, event: AppEvent): void {
    const sessionId = event.sessionId;
    switch (event.type) {
      case "agent.state": {
        if (sessionId === undefined) return;
        const state = asRecord(event.payload).state;
        stream.emit("api-session/status", [sessionId, typeof state === "string" && state !== "idle"]);
        return;
      }
      case "session.created":
      case "session.updated": {
        if (sessionId === undefined) return;
        stream.emit("api-session/activity", [sessionId, Date.parse(event.createdAt) || 0]);
        void this.emitSummary(stream, sessionId);
        return;
      }
      case "permission.request": {
        if (sessionId === undefined) return;
        const payload = asRecord(event.payload);
        const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
        if (requestId === undefined) return;
        const request: Record<string, unknown> = { toolName: typeof payload.tool === "string" ? payload.tool : "unknown" };
        const eventId = stream.request("approval/request", sessionId, request, (outcome) => {
          this.pendingBySource.delete(this.sourceKey(sessionId, requestId));
          void this.settlePermission(sessionId, requestId, outcome);
        });
        this.pendingBySource.set(this.sourceKey(sessionId, requestId), { clientId: stream.clientId, eventId });
        return;
      }
      case "permission.resolved": {
        if (sessionId === undefined) return;
        const requestId = asRecord(event.payload).requestId;
        if (typeof requestId !== "string") return;
        const key = this.sourceKey(sessionId, requestId);
        const entry = this.pendingBySource.get(key);
        if (entry === undefined) return;
        this.pendingBySource.delete(key);
        stream.cancel(entry.eventId, "审批已在 owc 侧结束");
        return;
      }
      case "interaction.requested": {
        if (sessionId === undefined) return;
        const payload = asRecord(event.payload);
        const requestId = typeof payload.id === "string" ? payload.id : undefined;
        if (requestId === undefined) return;
        const options = Array.isArray(payload.options) ? payload.options : [];
        const questions = [{
          id: requestId,
          question: typeof payload.prompt === "string" ? payload.prompt : "",
          ...(typeof payload.title === "string" ? { header: payload.title } : {}),
          ...(options.length === 0 ? {} : {
            options: options.map((option) => {
              const record = asRecord(option);
              return {
                label: typeof record.label === "string" ? record.label : String(record.id ?? ""),
                ...(typeof record.description === "string" ? { description: record.description } : {}),
              };
            }),
            multiSelect: payload.kind === "multi_select",
          }),
        }];
        const eventId = stream.request("user-questions/request", sessionId, { questions }, (outcome) => {
          this.pendingBySource.delete(this.sourceKey(sessionId, requestId));
          void this.settleInteraction(sessionId, requestId, outcome);
        });
        this.pendingBySource.set(this.sourceKey(sessionId, requestId), { clientId: stream.clientId, eventId });
        return;
      }
      case "interaction.answered": {
        if (sessionId === undefined) return;
        const requestId = asRecord(event.payload).id;
        if (typeof requestId !== "string") return;
        const key = this.sourceKey(sessionId, requestId);
        const entry = this.pendingBySource.get(key);
        if (entry === undefined) return;
        this.pendingBySource.delete(key);
        stream.cancel(entry.eventId, "提问已在 owc 侧回答");
        return;
      }
      default:
        return;
    }
  }

  /** 会话摘要（`api-session/added` 的载荷）：读尾部消息后投影。 */
  private async emitSummary(stream: DshEventStream, sessionId: string): Promise<void> {
    const projected = await projectSessionList(this.deps.projection);
    if ("error" in projected) return;
    const summary = (projected.value.items as Array<Record<string, unknown>>).find((item) => item.sessionId === sessionId);
    if (summary === undefined) return;
    stream.emit("api-session/added", [summary]);
  }

  /** 审批结果 → owc 决定（`allowed-once`→allow；其余拒绝/回落）。 */
  private async settlePermission(sessionId: string, requestId: string, outcome: DshWaterfallOutcome): Promise<void> {
    if (outcome.kind !== "result") return;
    const value = outcome.value;
    if (value === "allowed-once") {
      await this.deps.respondPermission(sessionId, requestId, "allow");
      return;
    }
    const reason = typeof value === "string" ? `dsh 审批结果：${value}` : "dsh 侧未批准";
    await this.deps.respondPermission(sessionId, requestId, "deny", reason);
  }

  /** 提问答案 → owc 交互应答（结构差异在翻译层收敛）。 */
  private async settleInteraction(sessionId: string, requestId: string, outcome: DshWaterfallOutcome): Promise<void> {
    if (outcome.kind !== "result") return;
    const answers = asRecord(asRecord(outcome.value)).answers;
    if (!Array.isArray(answers)) return;
    const first = asRecord(answers[0]);
    const selected = Array.isArray(first.selected) ? first.selected.filter((entry): entry is string => typeof entry === "string") : [];
    const custom = typeof first.custom === "string" ? first.custom : undefined;
    await this.deps.respondInteraction(sessionId, requestId, { selected, ...(custom === undefined ? {} : { custom }) });
  }

  private sourceKey(sessionId: string, requestId: string): string {
    return `${sessionId}\u0000${requestId}`;
  }

  private clearPending(eventId: string): void {
    for (const [key, entry] of [...this.pendingBySource]) {
      if (entry.eventId === eventId) this.pendingBySource.delete(key);
    }
  }
}

/** 逻辑流端点表。 */
export function buildStreamHandlers(deps: DshWireDeps, bridge: DshEventBridge): Map<string, DshMuxEndpointHandler> {
  const handlers = new Map<string, DshMuxEndpointHandler>();
  handlers.set(DSH_EVENTS_STREAM, (handle) => bridge.open(handle));
  handlers.set("session/control", async (handle) => {
    const sessionId = typeof handle.args.sessionId === "string" ? handle.args.sessionId : undefined;
    if (sessionId === undefined) {
      handle.fail(wireError("session/arguments-invalid", "args.sessionId 缺失"));
      return;
    }
    const baseline = await projectSessionControlBaseline(deps.projection, sessionId);
    if ("error" in baseline) {
      handle.fail(baseline.error);
      return;
    }
    handle.send(baseline.value);
    // 增量（queue/jobs 变化）v1 不发：dsh UI 侧以 follow 的会话事件为准，见 docs
  });
  handlers.set("session/follow", async (handle) => {
    const address = asRecord(asRecord(handle.args.request).address);
    const sessionId = typeof address.sessionId === "string" ? address.sessionId : undefined;
    if (address.kind !== "session" || sessionId === undefined) {
      handle.fail(wireError("session/unsupported", "v1 仅支持 kind=session 的 follow 地址"));
      return;
    }
    const snapshot = await projectSessionFollowSnapshot(deps.projection, handle.args);
    if ("error" in snapshot) {
      handle.fail(snapshot.error);
      return;
    }
    handle.send(snapshot.value);
    const cursorValue = (snapshot.value as { cursor?: unknown }).cursor;
    let cursor = typeof cursorValue === "number" ? cursorValue : 0;
    // 增量：owc 侧回合结束（agent.state → idle）或会话更新时，重派生事件并只发 seq > cursor 的记录。
    // 逐 token 的 assistant-stream 帧 v1 不发（如实：不编造增量），完成后的完整消息立即下发。
    let sending = false;
    const listener = (event: AppEvent): void => {
      if (event.sessionId !== sessionId) return;
      if (event.type !== "agent.state" && event.type !== "session.updated") return;
      if (sending) return;
      sending = true;
      void (async () => {
        try {
          const records = await sessionRecordsSince(deps.projection, sessionId, cursor);
          for (const record of records) {
            if (handle.cancelled) return;
            handle.send(record);
            const seq = (record.event as { seq?: unknown }).seq;
            if (typeof seq === "number") cursor = seq;
          }
        } catch (error) {
          deps.logger.warn(`dsh session/follow 增量失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          sending = false;
        }
      })();
    };
    deps.events.on("event", listener);
    handle.onCancel(() => deps.events.off("event", listener));
  });
  handlers.set("workspace/follow", async (handle) => {
    handle.send(await projectWorkspaceBaseline(deps.projection));
  });
  return handlers;
}

