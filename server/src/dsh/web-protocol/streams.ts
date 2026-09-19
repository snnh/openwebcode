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

/**
 * dsh 答案里的肯定语义（confirm / plan_approval 用）。
 *
 * dsh 的 `user-questions/request` 对没有 options 的提问只回自由文本（custom），无法表达强类型布尔，
 * 因此这里按一组显式词表判定「肯定」；不匹配一律按否定处理（批准类判定绝不因畸形响应放行）。
 */
const AFFIRMATIVE_ANSWERS = new Set([
  "y", "yes", "true", "ok", "okay", "approve", "approved", "confirm", "confirmed", "allow", "allowed", "accept", "1",
  "是", "好", "好的", "确认", "同意", "允许", "批准", "继续", "可以",
]);

/** dsh 单个问题答案 → owc `respondInteraction` 的 answer（按交互 kind 判别式，见 settleInteraction 注释）。 */
function toOwcInteractionAnswer(kind: string, answer: Record<string, unknown>): unknown {
  const selected = Array.isArray(answer.selected) ? answer.selected.filter((item): item is string => typeof item === "string") : [];
  const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
  const affirmative = AFFIRMATIVE_ANSWERS.has((custom !== "" ? custom : selected.join(" ")).trim().toLowerCase());
  if (kind === "confirm") return affirmative;
  if (kind === "plan_approval") {
    if (affirmative) return { decision: "approve" };
    return { decision: "reject", feedback: custom !== "" ? custom : selected.join(", ") };
  }
  if (kind === "text") return custom !== "" ? custom : selected.join("\n");
  // single_select / multi_select：owc 收选项 label 数组；自定义答案用上游的 other:<文本> 约定传递
  return [...selected, ...(custom === "" ? [] : [`other:${custom}`])];
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
      case "agent.error": {
        if (sessionId === undefined) return;
        // 与上游 `api-session/error(sessionId, message)` 同签名：UI 的「无回合位置的实时失败」出口
        // （dsh-client-ui-chat 的错误位 / session-controller 的 handleSessionError）
        const message = asRecord(event.payload).message;
        if (typeof message !== "string" || message === "") return;
        stream.emit("api-session/error", [sessionId, message]);
        return;
      }
      case "session.deleted": {
        if (sessionId === undefined) return;
        // 删除后侧边栏条目必须消失（`api-session/removed` 此前从不发，条目会残留到下次刷新）
        stream.emit("api-session/removed", [sessionId]);
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
        const kind = typeof payload.kind === "string" ? payload.kind : "text";
        const options = Array.isArray(payload.options) ? payload.options : [];
        const questions = [{
          // 问题 id 用 owc 交互 id：应答回路按该 id 找回来源交互
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
            multiSelect: kind === "multi_select",
          }),
        }];
        const eventId = stream.request("user-questions/request", sessionId, { questions }, (outcome) => {
          this.pendingBySource.delete(this.sourceKey(sessionId, requestId));
          void this.settleInteraction(sessionId, requestId, kind, outcome);
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

  /**
   * 提问答案 → owc 交互应答。
   *
   * 两侧契约（本地核对：`agent/agent-runner.ts` 的 `normalizeAskUserAnswer` /
   * `parsePlanApprovalDecision` + `routes/sessions-run.ts` 的 `respond` 路由）：
   * - owc 一次 `respondInteraction(sessionId, id, answer)` 只对应**一个问题**（`ask_user` 逐题串行建交互）；
   * - owc 的 answer 形状按交互 kind 区分：confirm→boolean、text→string、
   *   single_select/multi_select→选项 label 数组（自定义答案是 `other:<文本>`）、plan_approval→`{decision,…}`；
   * - dsh 侧回的是整份答案数组（每个问题一条 `{id, selected, custom?}`），按问题 id 归位。
   *
   * 因此这里：按 id 取回本交互对应的那一条答案，并全量映射（selected 多项与 custom 都不丢）；
   * dsh 侧多出来的答案（问题数 > owc 交互数，理论不可达）不静默接受，如实写日志并按已知限制丢弃。
   */
  private async settleInteraction(sessionId: string, requestId: string, kind: string, outcome: DshWaterfallOutcome): Promise<void> {
    if (outcome.kind !== "result") return;
    const answers = asRecord(asRecord(outcome.value)).answers;
    if (!Array.isArray(answers)) return;
    const entries = answers.map(asRecord);
    // 归位：问题 id 即 owc 交互 id；只有一条答案时无条件接受（兼容客户端省略 id 的形态）
    const entry = entries.find((candidate) => candidate.id === requestId) ?? (entries.length === 1 ? entries[0] : undefined);
    if (entry === undefined) {
      this.deps.logger.warn(`dsh 提问应答无法归位（requestId=${requestId}，answers=${entries.length} 条）：已忽略`);
      return;
    }
    const dropped = entries.length - 1;
    if (dropped > 0) {
      // owc 一个交互只接受一个答案：多出来的答案无处落地，如实记录而不是假装已接受
      this.deps.logger.warn(`dsh 提问应答含 ${dropped} 条多余答案（requestId=${requestId}）：owc 单交互仅接受一个答案，已按问题 id 取一条`);
    }
    await this.deps.respondInteraction(sessionId, requestId, toOwcInteractionAnswer(kind, entry));
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
    // 该端点协议上无参数（vendor 描述符 parameters: []，客户端 open 帧 payload 恒为 {args:{}}）：
    // 基线是 Host 级的（全部会话的投影），绝不因缺 args.sessionId 而 fail
    const baseline = await projectSessionControlBaseline(deps.projection);
    if ("error" in baseline) {
      handle.fail(baseline.error);
      return;
    }
    handle.send(baseline.value);
    // 增量（jobs / projection 帧）v1 不发：dsh UI 侧以 follow 的会话事件为准，见 docs
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
    let cursor = typeof cursorValue === "number" ? cursorValue : -1;
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

