import { randomUUID } from "node:crypto";
import type { EventBus } from "../events/event-bus.js";
import type { PermissionMode, PermissionRule } from "../sessions/types.js";

export type PermissionDecision = "allow" | "allow_always" | "deny";

interface PendingPermission {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  resolve: (value: { allowed: boolean; reason?: string; persist: boolean }) => void;
  signal: AbortSignal;
  abort: () => void;
}

export class PermissionCoordinator {
  private readonly pending = new Map<string, PendingPermission>();

  constructor(private readonly events: EventBus) {}

  needsApproval(mode: PermissionMode, rules: PermissionRule[], tool: string, input: Record<string, unknown>): boolean {
    // 只读工具 + remember 自动放行：remember 是 agent 写自身长期记忆（低风险），
    // 写入路径固定为 <cwd>/.owc/memory.md 或 <dataDir>/memory.md，不接受任意路径
    if (["read_file", "glob", "grep", "read_artifact", "load_skill", "spawn_task", "todo_write", "remember"].includes(tool)) return false;
    if (mode === "yolo") return false;
    if (mode === "acceptEdits" && ["write_file", "edit_file"].includes(tool)) return false;
    return !rules.some((rule) => matchesRule(rule, tool, input));
  }

  request(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ allowed: boolean; reason?: string; persist: boolean }> {
    signal.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const abort = () => {
        this.pending.delete(requestId);
        resolve({ allowed: false, reason: "Permission request aborted", persist: false });
      };
      this.pending.set(requestId, { sessionId, tool, input, resolve, signal, abort });
      signal.addEventListener("abort", abort, { once: true });
      this.events.publish({ source: "agent", type: "permission.request", sessionId, payload: { requestId, tool, input } });
    });
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
    pending.signal.removeEventListener("abort", pending.abort);
    const persist = decision === "allow_always";
    return {
      tool: pending.tool,
      input: pending.input,
      persist,
      complete: (allowed = decision !== "deny", failureReason = reason) => pending.resolve({ allowed, ...(failureReason ? { reason: failureReason } : {}), persist: allowed && persist }),
    };
  }

  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      pending.signal.removeEventListener("abort", pending.abort);
      pending.resolve({ allowed: false, reason: "Session stopped", persist: false });
    }
  }
}

export function permissionRule(tool: string, input: Record<string, unknown>): PermissionRule {
  if (tool === "bash" && typeof input.cmd === "string") return { tool, argumentPrefix: input.cmd };
  if (["write_file", "edit_file"].includes(tool) && typeof input.path === "string") return { tool, argumentPrefix: input.path };
  return { tool };
}

function matchesRule(rule: PermissionRule, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  if (rule.argumentPrefix === undefined) return true;
  const value = tool === "bash" ? input.cmd : input.path;
  if (typeof value !== "string") return false;
  if (tool === "bash") return value === rule.argumentPrefix;
  return value === rule.argumentPrefix || value.startsWith(`${rule.argumentPrefix}/`);
}
