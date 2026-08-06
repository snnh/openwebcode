import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EventBus } from "./events/event-bus.js";

export type HookEvent =
  | "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart"
  | "PreCompact" | "PostCompact" | "SessionEnd" | "Notification" | "SubagentStart" | "SubagentStop";

export interface HookEntry {
  matcher: string;
  command: string;
}

export type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

export interface HookPayload {
  sessionId: string;
  cwd: string;
  /** 工具事件携带工具名（内置名，与权限判定同名空间）；UserPromptSubmit/Stop/SessionStart/SessionEnd 无 tool（matcher 仅 "*" 命中） */
  tool?: string;
  /** env-sim 等工具形态别名激活时的模型侧别名（如 execute_command）；与内置名一致或无别名时缺省 */
  toolAlias?: string;
  input?: unknown;
  /** PostToolUse：结果摘要（截断） */
  result?: unknown;
  /** UserPromptSubmit：展开后的用户消息正文（截断）；SubagentStart：子代理任务摘要（截断） */
  prompt?: string;
  /** Notification：待批/待答事项摘要 */
  notification?: { kind: "permission" | "interaction"; summary: string };
  /** PreCompact/PostCompact：压缩策略与触发方式；PostCompact 附带结果 */
  compact?: {
    strategy: "toolcalls" | "overview";
    forced: boolean;
    changed?: boolean | undefined;
    finalMode?: string | undefined;
    uptoIndex?: number | undefined;
  };
  /** SubagentStart/SubagentStop：子代理标识（含 swarm 成员）；SubagentStop 附终态 */
  subagent?: {
    taskId: string;
    agent?: string | undefined;
    kind?: string | undefined;
    swarm?: { index: number; total: number } | undefined;
    status?: "done" | "failed" | undefined;
    error?: string | undefined;
  };
}

export interface HookOutcome {
  blocked?: boolean;
  reason?: string;
}

/**
 * Hooks：可信配置（与 yolo 同级，文档警示）。项目 <cwd>/.owc/hooks.json 覆盖/补充全局
 * <dataDir>/hooks.json——数组按项目在前合并；每次事件现读两份配置（热更新免重启），
 * 坏 JSON 告警跳过不阻断。
 *
 * 执行语义：shell 命令 stdin=JSON 事件负载，5s 超时杀进程。exit 0=放行；
 * exit 2=否决（仅 Pre* 类 PreToolUse/PreCompact 有意义，stderr 回填调用方）；其他非零/超时=告警不阻断（hook.failed 事件）。
 * Notification、Subagent 类、SessionEnd、PostCompact 等通知类事件失败与退出码均不阻塞主流程。
 */
export class HookRunner {
  private static readonly TIMEOUT_MS = 5000;
  private static readonly MAX_STDERR = 4000;

  constructor(private readonly globalPath: string, private readonly events?: EventBus) {}

  async run(event: HookEvent, payload: HookPayload): Promise<HookOutcome> {
    const entries = await this.loadEntries(event, payload);
    for (const entry of entries) {
      if (!matchesMatcher(entry.matcher, payload.tool)) continue;
      const result = await this.execute(entry.command, payload);
      if (result.exitCode === 0) continue;
      if (result.exitCode === 2 && (event === "PreToolUse" || event === "PreCompact")) {
        const reason = result.stderr.trim() || `Hook 拒绝了${event === "PreToolUse" ? `工具 ${payload.tool ?? event}` : "上下文压缩"}`;
        return { blocked: true, reason };
      }
      // 其他非零与超时：告警不阻断
      this.events?.publish({
        source: "server",
        type: "hook.failed",
        sessionId: payload.sessionId,
        payload: {
          event,
          command: entry.command,
          ...(result.exitCode === null ? { timeout: true } : { exitCode: result.exitCode }),
          stderr: result.stderr.slice(0, HookRunner.MAX_STDERR),
        },
      });
    }
    return {};
  }

  /** 项目级在前、全局在后合并；坏 JSON 告警并按空配置处理 */
  private async loadEntries(event: HookEvent, payload: HookPayload): Promise<HookEntry[]> {
    const project = await this.readHooksFile(path.join(payload.cwd, ".owc", "hooks.json"), payload.sessionId);
    const global = await this.readHooksFile(this.globalPath, payload.sessionId);
    return [...(project[event] ?? []), ...(global[event] ?? [])];
  }

  private async readHooksFile(file: string, sessionId: string): Promise<HooksConfig> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return {}; // 不存在：正常路径
    }
    try {
      return normalizeHooksConfig(JSON.parse(raw) as unknown);
    } catch (error) {
      this.events?.publish({
        source: "server",
        type: "hook.failed",
        sessionId,
        payload: { event: "config", command: file, stderr: `hooks.json 解析失败：${error instanceof Error ? error.message : String(error)}` },
      });
      return {};
    }
  }

  private execute(command: string, payload: HookPayload): Promise<{ exitCode: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const shell = process.platform === "win32" ? "cmd.exe" : "sh";
      const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
      const stderr: string[] = [];
      let settled = false;
      const settle = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, stderr: stderr.join("") });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(shell, args, { cwd: payload.cwd, windowsHide: true, windowsVerbatimArguments: true });
      } catch (error) {
        resolve({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) });
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        stderr.push("(hook timeout)");
        settle(null);
      }, HookRunner.TIMEOUT_MS);
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
      child.on("error", (error) => {
        stderr.push(error.message);
        settle(1);
      });
      child.on("close", (code) => settle(code));
      try {
        child.stdin?.write(JSON.stringify(payload));
        child.stdin?.end();
      } catch {
        // stdin 写入失败不影响命令执行与退出码判定
      }
    });
  }
}

/** matcher：精确工具名、"前缀*" 前缀匹配、"*" 全匹配；无 tool 的事件仅 "*" 命中 */
export function matchesMatcher(matcher: string, tool: string | undefined): boolean {
  if (matcher === "*") return true;
  if (tool === undefined) return false;
  if (matcher.endsWith("*")) return tool.startsWith(matcher.slice(0, -1));
  return tool === matcher;
}

/** 校验并归一 hooks.json：事件名白名单、entry 需 matcher+command 字符串，坏条目丢弃 */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart",
  "PreCompact", "PostCompact", "SessionEnd", "Notification", "SubagentStart", "SubagentStop",
];

export function normalizeHooksConfig(value: unknown): HooksConfig {
  if (!value || typeof value !== "object") return {};
  const config: HooksConfig = {};
  for (const event of HOOK_EVENTS) {
    const entries = (value as Record<string, unknown>)[event];
    if (!Array.isArray(entries)) continue;
    const valid = entries.filter((entry): entry is HookEntry =>
      Boolean(entry) && typeof entry === "object" &&
      typeof (entry as HookEntry).matcher === "string" && (entry as HookEntry).matcher !== "" &&
      typeof (entry as HookEntry).command === "string" && (entry as HookEntry).command !== "");
    if (valid.length > 0) config[event] = valid;
  }
  return config;
}
