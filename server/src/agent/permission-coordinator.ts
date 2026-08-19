import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EventBus } from "../events/event-bus.js";
import type { PermissionMode, PermissionRule } from "../sessions/types.js";
import { isReadOnlyCommand } from "./readonly-command.js";

export type PermissionDecision = "allow" | "allow_always" | "deny";

interface PendingPermission {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  resolve: (value: { allowed: boolean; reason?: string; persist: boolean }) => void;
  signal: AbortSignal;
  abort: () => void;
  /** 与权限模式无关、必须人工裁决的挂起单（本机会话 HOME 外路径门）：reconcile 永不自动放行。 */
  alwaysManual?: boolean;
}

export class PermissionCoordinator {
  private readonly pending = new Map<string, PendingPermission>();

  constructor(private readonly events: EventBus) {}

  needsApproval(mode: PermissionMode, rules: PermissionRule[], tool: string, input: Record<string, unknown>): boolean {
    // 只读工具 + remember 自动放行：remember 是 agent 写自身长期记忆（低风险），
    // 写入路径固定为 <cwd>/.owc/memory.md 或 <dataDir>/memory.md，不接受任意路径
    if (["read_file", "glob", "grep", "read_artifact", "load_skill", "subagent", "spawn_task", "spawn_swarm", "todo_write", "remember", "task_output", "repo_map", "code_search", "git_status", "git_diff", "ask_user", "exit_plan_mode", "swarm_board_post", "swarm_board_read", "cron_create", "cron_list", "cron_delete"].includes(tool)) return false;
    // 只读探查命令自动放行：`cd x && echo ... && head ...` 等纯只读链（词法级判定，
    // 含 &&/|/; 分段逐段白名单，无重定向/命令替换/写命令）不需要人工批准。
    // 判定保守：任何无法证明只读的形态都转人工；放行不改变沙盒/路径策略，
    // PreToolUse 钩子仍在放行后触发（exit 2 可拦截）。
    if (tool === "bash" && typeof input.cmd === "string" && isReadOnlyCommand(input.cmd)) return false;
    // git_commit 默认不开放给 agent 自动执行：yolo 也不隐含提交授权（plan §4.3），
    // 只有用户对 git_commit 显式 allow_always（按会话授权）后才跳过确认。
    if (tool === "git_commit") return !rules.some((rule) => matchesRule(rule, tool, input));
    if (mode === "yolo") return false;
    if (mode === "acceptEdits" && ["write_file", "edit_file"].includes(tool)) return false;
    return !rules.some((rule) => matchesRule(rule, tool, input));
  }

  request(sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal, opts?: { alwaysManual?: boolean }): Promise<{ allowed: boolean; reason?: string; persist: boolean }> {
    signal.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const abort = () => {
        this.pending.delete(requestId);
        this.publishResolved(sessionId, requestId);
        resolve({ allowed: false, reason: "Permission request aborted", persist: false });
      };
      this.pending.set(requestId, { sessionId, tool, input, resolve, signal, abort, ...(opts?.alwaysManual ? { alwaysManual: true } : {}) });
      signal.addEventListener("abort", abort, { once: true });
      this.events.publish({ source: "agent", type: "permission.request", sessionId, payload: { requestId, tool, input } });
    });
  }

  /**
   * 权限模式/规则运行中热切换后结算挂起单：新档下已不再需要审批的请求自动放行
   * （切 yolo 全放行；切 acceptEdits 放行挂起的 write/edit）。alwaysManual 条目
   * （本机会话 HOME 外路径门）与新模式无关，永不自动放行。
   */
  reconcile(sessionId: string, mode: PermissionMode, rules: PermissionRule[]): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId || pending.alwaysManual) continue;
      if (this.needsApproval(mode, rules, pending.tool, pending.input)) continue;
      this.pending.delete(requestId);
      this.publishResolved(sessionId, requestId);
      pending.signal.removeEventListener("abort", pending.abort);
      pending.resolve({ allowed: true, persist: false });
    }
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
    const persist = decision === "allow_always";
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

export function permissionRule(tool: string, input: Record<string, unknown>): PermissionRule {
  if (tool === "bash" && typeof input.cmd === "string") return { tool, argumentPrefix: input.cmd };
  // 文件类工具（含只读三件套）：规则按归一化路径的目录前缀落——本机会话的 HOME 外路径门
  // 依赖 read_file/glob/grep 也生成路径规则（旧行为整工具放行过宽）。落 dirname 而非完整
  // 路径：「总是允许 /etc/hosts」应放行同目录的 /etc/hostname（matchesRule 按目录前缀匹配），
  // 而非仅单文件。glob/grep 的 path 本身是目录，dirname 会缩到父目录——这类按原值保留。
  // 缺省/空 path（会话根）不落规则，回落整工具。
  if (["read_file", "write_file", "edit_file"].includes(tool) && typeof input.path === "string" && input.path) {
    const dir = path.posix.dirname(input.path);
    return { tool, argumentPrefix: dir === "." || dir === "/" ? input.path : dir };
  }
  if (["glob", "grep"].includes(tool) && typeof input.path === "string" && input.path) {
    return { tool, argumentPrefix: input.path };
  }
  if (tool === "web_fetch" && typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      if (url.protocol === "http:" || url.protocol === "https:") return { tool, argumentPrefix: url.origin };
    } catch {
      // 非法 URL 不得退化为整个工具永久放行
    }
    return { tool, argumentPrefix: "invalid:" };
  }
  return { tool };
}

/**
 * bash 规则的词边界前缀匹配（提交⑨）：`npm test` 规则放行 `npm test -- --watch`，
 * 不放行 `npm testx`。前缀之后的剩余串若含 shell 控制元字符（管道/连接/重定向/
 * 命令替换/换行）则不适用前缀语义，回退整串精确——否则「总是允许 npm test」会
 * 连带放行 `npm test && curl evil`。
 */
// \r 必须在列：cmd.exe 把孤立 CR 当行终止符，「npm test \rwhoami」会执行两条命令
const SHELL_CONTROL_CHARS = /[&|;><`\n\r]|\$\(/;
function matchesBashRule(prefix: string, value: string): boolean {
  if (value === prefix) return true;
  if (!value.startsWith(`${prefix} `)) return false;
  return !SHELL_CONTROL_CHARS.test(value.slice(prefix.length + 1));
}

function matchesRule(rule: PermissionRule, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  if (rule.argumentPrefix === undefined) return true;
  if (tool === "web_fetch") {
    if (typeof input.url !== "string") return false;
    try { return new URL(input.url).origin === rule.argumentPrefix; } catch { return false; }
  }
  const value = tool === "bash" ? input.cmd : input.path;
  if (typeof value !== "string") return false;
  if (tool === "bash") return matchesBashRule(rule.argumentPrefix, value);
  return value === rule.argumentPrefix || value.startsWith(`${rule.argumentPrefix}/`);
}

export { matchesRule };
