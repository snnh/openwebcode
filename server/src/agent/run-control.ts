import type { EventBus } from "../events/event-bus.js";
import { errorMessage } from "../error-utils.js";
import type { HookPayload } from "../hooks.js";
import { activePathMessages } from "../sessions/session-tree.js";
import type { SessionStore } from "../sessions/session-store.js";
import { MessageQueue, type QueueItem } from "./message-queue.js";
import { InteractionCoordinator, type InteractionKind, type InteractionRequest } from "./interaction-coordinator.js";

export class SteeringError extends Error {
  constructor(message: string, readonly code: "not_running" | "too_long" | "full") {
    super(message);
    this.name = "SteeringError";
  }
}

const MAX_STEERING_ITEMS = 16;
const MAX_STEERING_LENGTH = 8_000;

/** goal 模式：自动续跑次数上限与续跑消息前缀（消息落盘即持久化，重启后计数自然恢复）。 */
const GOAL_MAX_CONTINUATIONS = 10;
const GOAL_CONTINUATION_PREFIX = "[goal-continuation]";

/**
 * RunControl 的外部依赖面（全部来自 AgentRunner 组合注入）：
 * running/settling 为共享引用，与主循环的状态判断保持同一份真相；
 * run 回调供 startFollowUp 补一轮；notify 为非拦截 Notification 钩子。
 */
interface RunControlDeps {
  sessions: SessionStore;
  events: EventBus;
  running: Map<string, AbortController>;
  settling: Set<string>;
  run: (sessionId: string, text: string, options: { queueItemId: string }) => Promise<void>;
  notify: (payload: HookPayload) => Promise<void>;
}

/**
 * steering/消息队列/交互管理外观（自 agent-runner.ts 抽出的纯代码移动，行为不变）：
 * enqueue/list/update/remove 队列项、交互创建与应答、ask_user 挂起等待、
 * goal 模式自动续跑与 follow_up 补轮。AgentRunner 组合持有本类并做一行委托。
 */
export class RunControl {
  private readonly messageQueue: MessageQueue;
  private readonly interactions: InteractionCoordinator;
  /** ask_user 挂起等待：interactionId → waiter；respondInteraction 解析，run abort 经 signal 监听器解析为 cancelled。 */
  private readonly interactionWaiters = new Map<string, { sessionId: string; resolve: (answer: unknown) => void; signal: AbortSignal; abort: () => void }>();

  constructor(private readonly deps: RunControlDeps) {
    this.messageQueue = new MessageQueue((sessionId) => deps.sessions.contextRoot(sessionId));
    this.interactions = new InteractionCoordinator((sessionId) => deps.sessions.contextRoot(sessionId));
  }

  async enqueueSteering(sessionId: string, content: string, requestId?: string): Promise<{ id: string; position: number; reused: boolean }> {
    if (!this.deps.running.has(sessionId)) throw new SteeringError("Session agent is not running", "not_running");
    if (this.deps.settling.has(sessionId)) throw new SteeringError("Session is settling; retry after it becomes idle", "not_running");
    if (content.length > MAX_STEERING_LENGTH) throw new SteeringError(`Steering message exceeds ${MAX_STEERING_LENGTH} characters`, "too_long");
    const queuedItems = await this.messageQueue.list(sessionId, "steer");
    if (queuedItems.filter((item) => item.status === "queued").length >= MAX_STEERING_ITEMS) throw new SteeringError("Steering queue is full", "full");
    const queued = await this.messageQueue.enqueue(sessionId, "steer", content, requestId);
    const payload = { ...queued.item, position: queued.position, reused: queued.reused };
    this.deps.events.publish({ source: "agent", type: "queue.queued", sessionId, payload });
    this.deps.events.publish({ source: "agent", type: "steering.queued", sessionId, payload });
    return { id: queued.item.id, position: queued.position, reused: queued.reused };
  }

  async enqueueFollowUp(sessionId: string, content: string, requestId?: string): Promise<{ id: string; position: number; reused: boolean }> {
    if (!this.deps.running.has(sessionId)) throw new SteeringError("Session agent is not running", "not_running");
    if (content.length > MAX_STEERING_LENGTH) throw new SteeringError(`Follow-up message exceeds ${MAX_STEERING_LENGTH} characters`, "too_long");
    const queuedItems = await this.messageQueue.list(sessionId, "follow_up");
    if (queuedItems.filter((item) => item.status === "queued").length >= MAX_STEERING_ITEMS) throw new SteeringError("Follow-up queue is full", "full");
    const queued = await this.messageQueue.enqueue(sessionId, "follow_up", content, requestId);
    const payload = { ...queued.item, position: queued.position, reused: queued.reused };
    this.deps.events.publish({ source: "agent", type: "queue.queued", sessionId, payload });
    return { id: queued.item.id, position: queued.position, reused: queued.reused };
  }

  /**
   * cron 触发注入（提交⑫）：与 enqueueFollowUp 不同，不要求会话 running——
   * 运行中自然排队（run 收尾的 startFollowUp 消费），空闲/settling 由这里立即补一轮。
   * 队列项标记 source:"cron" 随 queue.json 持久化。
   */
  async fireCronFollowUp(sessionId: string, content: string): Promise<{ id: string; position: number }> {
    if (content.length > MAX_STEERING_LENGTH) throw new SteeringError(`Cron prompt exceeds ${MAX_STEERING_LENGTH} characters`, "too_long");
    const queuedItems = await this.messageQueue.list(sessionId, "follow_up");
    if (queuedItems.filter((item) => item.status === "queued").length >= MAX_STEERING_ITEMS) throw new SteeringError("Follow-up queue is full", "full");
    const queued = await this.messageQueue.enqueue(sessionId, "follow_up", content, undefined, "cron");
    const payload = { ...queued.item, position: queued.position, reused: queued.reused };
    this.deps.events.publish({ source: "agent", type: "queue.queued", sessionId, payload });
    // 运行中/settling 由 run 收尾的 startFollowUp 兜底；全空闲时这里立即启动
    if (!this.deps.running.has(sessionId) && !this.deps.settling.has(sessionId)) {
      void this.startFollowUp(sessionId).catch(() => { /* follow-up 失败经 queue.run_failed 事件记录 */ });
    }
    return { id: queued.item.id, position: queued.position };
  }

  async listSteering(sessionId: string): Promise<QueueItem[]> {
    return (await this.messageQueue.list(sessionId, "steer")).filter((item) => item.status === "queued");
  }
  async listQueue(sessionId: string): Promise<QueueItem[]> { return this.messageQueue.list(sessionId); }
  async updateQueue(sessionId: string, id: string, change: { content?: string; kind?: "steer" | "follow_up" }): Promise<QueueItem | undefined> {
    const item = await this.messageQueue.update(sessionId, id, change);
    if (item) this.deps.events.publish({ source: "agent", type: "queue.updated", sessionId, payload: item });
    return item;
  }
  async removeQueue(sessionId: string, id: string): Promise<boolean> {
    const item = await this.messageQueue.cancel(sessionId, id);
    if (!item) return false;
    this.deps.events.publish({ source: "agent", type: "queue.cancelled", sessionId, payload: { id: item.id, kind: item.kind } });
    return true;
  }

  async listInteractions(sessionId: string): Promise<InteractionRequest[]> { return this.interactions.list(sessionId); }
  async createInteraction(sessionId: string, input: { runId: string; toolCallId?: string; kind: InteractionKind; title: string; prompt: string; options?: Array<{ id: string; label: string; description?: string }>; allowOther?: boolean }): Promise<InteractionRequest> {
    const item = await this.interactions.create(sessionId, input);
    this.deps.events.publish({ source: "agent", type: "interaction.requested", sessionId, runId: item.runId, payload: item });
    // Notification 钩子：交互待答（仅通知不阻断）
    const session = await this.deps.sessions.getMeta(sessionId);
    if (session) {
      await this.deps.notify({ sessionId, cwd: session.cwd, notification: { kind: "interaction", summary: input.title } });
    }
    return item;
  }
  async respondInteraction(sessionId: string, id: string, answer: unknown): Promise<InteractionRequest | undefined> {
    const item = await this.interactions.answer(sessionId, id, answer);
    if (item) {
      this.deps.events.publish({ source: "agent", type: "interaction.answered", sessionId, payload: item });
      // ask_user 工具挂起等待：回答到达即恢复工具执行（镜像权限 respond 语义）
      const waiter = this.interactionWaiters.get(id);
      if (waiter) {
        this.interactionWaiters.delete(id);
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.resolve(item.answer);
      }
    }
    return item;
  }

  /**
   * 等待 ask_user 交互被回答；run abort 或交互已取消时解析为 { cancelled: true }，
   * 工具结果按 { cancelled: true } 返回（非错误），agent 可自行决定继续或收尾。
   */
  async waitForInteractionAnswer(sessionId: string, interactionId: string, signal: AbortSignal): Promise<{ cancelled: true } | { cancelled: false; answer: unknown }> {
    if (signal.aborted) return { cancelled: true };
    // 竞态防护：REST respond 可能先于 waiter 注册完成（事件发布与注册之间存在微任务窗口）
    const existing = (await this.interactions.list(sessionId)).find((item) => item.id === interactionId);
    if (existing && existing.status !== "pending") {
      return existing.status === "cancelled" ? { cancelled: true } : { cancelled: false, answer: existing.answer };
    }
    return new Promise((resolve) => {
      const abort = () => {
        this.interactionWaiters.delete(interactionId);
        resolve({ cancelled: true });
      };
      this.interactionWaiters.set(interactionId, { sessionId, resolve: (answer) => resolve({ cancelled: false, answer }), signal, abort });
      signal.addEventListener("abort", abort, { once: true });
      // 注册后复检：abort 可能在上面 signal.aborted 检查与本注册之间触发，
      // AbortSignal 事件已错过且不会再发，不复检则 waiter 永久挂起。
      // abort() 路径另由 cancelInteractionWaiters 主动解除兜底。
      if (signal.aborted) abort();
    });
  }

  /**
   * 主动解除会话所有挂起的 ask_user 交互等待，解析为 { cancelled: true }。
   * abort() 调用，与 permissions.cancelSession 同义：不依赖 signal 事件
   * （事件注册竞态下 listener 可能漏掉已发事件导致永久挂起）。
   */
  cancelInteractionWaiters(sessionId: string): void {
    for (const [id, waiter] of this.interactionWaiters) {
      if (waiter.sessionId !== sessionId) continue;
      this.interactionWaiters.delete(id);
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.abort();
    }
  }

  async removeSteering(sessionId: string, id: string): Promise<boolean> {
    const item = await this.messageQueue.cancel(sessionId, id);
    if (!item) return false;
    this.deps.events.publish({ source: "agent", type: "queue.cancelled", sessionId, payload: { id: item.id, kind: item.kind } });
    this.deps.events.publish({ source: "agent", type: "steering.removed", sessionId, payload: { id: item.id } });
    return true;
  }

  async applySteering(sessionId: string): Promise<boolean> {
    const item = await this.messageQueue.take(sessionId, "steer");
    if (!item) return false;
    try {
      const message = await this.deps.sessions.appendMessage(sessionId, "user", [{ type: "text", text: item.content }]);
      const applied = await this.messageQueue.apply(sessionId, item.id, message.id);
      if (!applied) throw new Error("Steering queue item disappeared while applying it");
      this.deps.events.publish({ source: "agent", type: "queue.applied", sessionId, payload: applied });
      this.deps.events.publish({ source: "agent", type: "steering.applied", sessionId, payload: applied });
      return true;
    } catch (error) {
      await this.messageQueue.requeue(sessionId, item.id);
      this.deps.events.publish({ source: "agent", type: "queue.apply_failed", sessionId, payload: { id: item.id, kind: item.kind, message: errorMessage(error) } });
      return false;
    }
  }

  /** run 循环内消费 follow_up 队列项：触发用户消息落盘后标记 applied。 */
  async applyFollowUp(sessionId: string, queueItemId: string, appliedMessageId: string): Promise<QueueItem | undefined> {
    return this.messageQueue.apply(sessionId, queueItemId, appliedMessageId);
  }

  /** run 失败/中断时把未消费的 follow_up 队列项放回队列。 */
  async requeueFollowUp(sessionId: string, queueItemId: string): Promise<QueueItem | undefined> {
    return this.messageQueue.requeue(sessionId, queueItemId);
  }

  /**
   * goal 模式自动续跑：run 正常结束且末条 assistant 消息含独占行 GOAL_INCOMPLETE 时，
   * 经 follow_up 队列自动追加一轮（队列机制负责 startFollowUp）。续跑上限 10 次，
   * 计数自最近一条普通用户消息之后、以 [goal-continuation] 前缀的 user 消息数；
   * 消息落盘即持久化，重启后计数自然恢复。GOAL_COMPLETE 或无标记不续跑。
   */
  async maybeScheduleGoalContinuation(sessionId: string): Promise<void> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session || session.agentMode !== "goal") return;
    // 队列中已有（用户手动排队的）follow_up 时不追加，避免插队
    if ((await this.messageQueue.list(sessionId, "follow_up")).some((item) => item.status === "queued")) return;
    const messages = activePathMessages(session.messages, session.activeLeafId);
    let lastAssistantText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      lastAssistantText = message.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      break;
    }
    // 独占行 GOAL_INCOMPLETE（容忍前后空白，允许行尾冒号 + 一句理由）
    const incomplete = /^[ \t]*GOAL_INCOMPLETE[ \t]*(?::[ \t]*(.+?))?[ \t\r]*$/m.exec(lastAssistantText);
    if (!incomplete) return;
    let continuations = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      const textBlock = message.content.find((block) => block.type === "text");
      const text = textBlock?.type === "text" ? textBlock.text : "";
      // 遇到最近的普通用户消息即停止：更早的续跑属于上一个目标
      if (!text.startsWith(GOAL_CONTINUATION_PREFIX)) break;
      continuations++;
    }
    if (continuations >= GOAL_MAX_CONTINUATIONS) {
      this.deps.events.publish({ source: "agent", type: "goal.stopped", sessionId, payload: { reason: "max_continuations", count: GOAL_MAX_CONTINUATIONS } });
      return;
    }
    const reason = incomplete[1]?.trim() || "无说明";
    await this.enqueueFollowUp(sessionId, `${GOAL_CONTINUATION_PREFIX} 目标自评未完成（${reason}）。请继续完成剩余工作。`);
  }

  async startFollowUp(sessionId: string): Promise<void> {
    if (this.deps.running.has(sessionId)) return;
    // Avoid creating queue.json for the overwhelmingly common no-follow-up path.
    // This also keeps a just-finished session from racing its caller's cleanup.
    if (!(await this.messageQueue.list(sessionId, "follow_up")).some((item) => item.status === "queued")) return;
    const item = await this.messageQueue.take(sessionId, "follow_up");
    if (!item) return;
    this.deps.events.publish({ source: "agent", type: "queue.consuming", sessionId, payload: item });
    void this.deps.run(sessionId, item.content, { queueItemId: item.id }).catch((error: unknown) => {
      this.deps.events.publish({
        source: "agent",
        type: "queue.run_failed",
        sessionId,
        payload: { id: item.id, kind: item.kind, message: errorMessage(error) },
      });
    });
  }
}
