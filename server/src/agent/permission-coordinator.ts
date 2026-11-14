import { randomUUID } from "node:crypto";
import type { EventBus } from "../events/event-bus.js";
import type { ReadonlyShellFlavor } from "./readonly-command.js";

export type PermissionDecision = "allow" | "allow_always" | "allow_always_global" | "deny";

interface PendingPermission {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  resolve: (value: { allowed: boolean; reason?: string; persist: boolean }) => void;
  signal: AbortSignal;
  abort: () => void;
  /** 与权限模式无关、必须人工裁决的挂起单（本机会话 HOME 外路径门）：reconcile 永不自动放行。 */
  alwaysManual?: boolean;
  /** 发起请求时生效 shell 的词法形态：只读命令判定依 shell 语义分流，reconcile 复查须用同一形态。 */
  shell: ReadonlyShellFlavor;
}

export class PermissionCoordinator {
  private readonly pending = new Map<string, PendingPermission>();

  constructor(private readonly events: EventBus) {}

  request(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal, opts?: { alwaysManual?: boolean; shell?: ReadonlyShellFlavor }): Promise<{ allowed: boolean; reason?: string; persist: boolean }> {
    signal.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const abort = () => {
        this.pending.delete(requestId);
        this.publishResolved(sessionId, requestId);
        resolve({ allowed: false, reason: "Permission request aborted", persist: false });
      };
      this.pending.set(requestId, { sessionId, tool, input, resolve, signal, abort, shell: opts?.shell ?? "sh", ...(opts?.alwaysManual ? { alwaysManual: true } : {}) });
      signal.addEventListener("abort", abort, { once: true });
      this.events.publish({ source: "agent", type: "permission.request", sessionId, payload: { requestId, tool, input } });
    });
  }

  /**
   * 权限模式/规则运行中热切换后结算挂起单：新档下已不再需要审批的请求自动放行
   * （切 yolo 全放行；切 acceptEdits 放行挂起的 write/edit）。alwaysManual 条目
   * （本机会话 HOME 外路径门）与新模式无关，永不自动放行。
   * 判定由调用方注入（单策略引擎），协调器只负责挂起单生命周期。
   */
  reconcile(sessionId: string, shouldAutoAllow: (request: { tool: string; input: Record<string, unknown>; shell: ReadonlyShellFlavor }) => boolean): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId || pending.alwaysManual) continue;
      if (!shouldAutoAllow({ tool: pending.tool, input: pending.input, shell: pending.shell })) continue;
      this.pending.delete(requestId);
      this.publishResolved(sessionId, requestId);
      pending.signal.removeEventListener("abort", pending.abort);
      pending.resolve({ allowed: true, persist: false });
    }
  }

  /** 跨会话待决权限计数（会话列表的 attention 标记用；O(待决数)） */
  pendingCountsBySession(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const pending of this.pending.values()) {
      counts.set(pending.sessionId, (counts.get(pending.sessionId) ?? 0) + 1);
    }
    return counts;
  }

  listPending(sessionId: string): Array<{ requestId: string; tool: string; input: Record<string, unknown> }> {
    const result: Array<{ requestId: string; tool: string; input: Record<string, unknown> }> = [];
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId === sessionId) result.push({ requestId, tool: pending.tool, input: pending.input });
    }
    return result;
  }

  respond(sessionId: string, requestId: string, decision: PermissionDecision, reason?: string): { tool: string; input: Record<string, unknown>; persist: boolean; complete(allowed?: boolean, failureReason?: string): void } | undefined {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return undefined;
    this.pending.delete(requestId);
    this.publishResolved(sessionId, requestId);
    pending.signal.removeEventListener("abort", pending.abort);
    const persist = decision !== "allow" && decision !== "deny";
    return {
      tool: pending.tool,
      input: pending.input,
      persist,
      complete: (allowed = decision !== "deny", failureReason = reason) => {
        const aborted = pending.signal.aborted;
        const granted = allowed && !aborted;
        pending.resolve({
          allowed: granted,
          ...(aborted ? { reason: "Permission request aborted" } : failureReason ? { reason: failureReason } : {}),
          persist: granted && persist,
        });
      },
    };
  }

  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      this.publishResolved(sessionId, id);
      pending.signal.removeEventListener("abort", pending.abort);
      pending.resolve({ allowed: false, reason: "Session stopped", persist: false });
    }
  }

  /** 挂起单消失（respond/abort/cancelSession 任一路径）广播一次，让其他客户端撤掉权限卡。 */
  private publishResolved(sessionId: string, requestId: string): void {
    this.events.publish({ source: "agent", type: "permission.resolved", sessionId, payload: { requestId } });
  }
}
