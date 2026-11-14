import path from "node:path";
import type { PermissionRule } from "../sessions/types.js";

/**
 * 工具能力与权限元数据的单一来源。
 *
 * 这里合并三类历史数据：
 * - 计划模式只读白名单（原 agent-runner PLAN_READONLY）
 * - 免批工具白名单（原 permission-coordinator needsApproval）
 * - allow_always 规则作用域（原 permission-coordinator permissionRule）
 *
 * 新增内置工具必须在此登记；未登记的内置工具按 external 处理（人工），
 * 避免新增工具因遗漏而默认放行。
 */

type ToolCapability = "read" | "write" | "exec" | "network" | "external" | "internal" | "orchestrate";
/** 智能审核/模型审核的分流档位；Phase 1 先保留现有 review 行为（model）。 */
type ReviewTier = "machine" | "model" | "human";
type AskOutcome = "auto" | "ask";
type RuleScope = "path-dir" | "command-prefix" | "origin" | "tool";
/** 调度分类（原 agent-runner TOOL_EXECUTION_CLASS）；与权限能力同表，避免两处漂移。 */
export type ToolExecutionClass = "read_only" | "workspace_write" | "process" | "external";

export interface ToolPolicy {
  capabilities: readonly ToolCapability[];
  /** 调度分类：决定并行资格与 tool.scheduling 事件，不改权限判定。 */
  execution: ToolExecutionClass;
  /** plan 模式是否只读可用 */
  planReadonly: boolean;
  /** ask 模式下是否无需人工 */
  ask: AskOutcome;
  /** acceptEdits 模式下是否无需人工（在 ask 基础上叠加写/编辑） */
  acceptEdits: AskOutcome;
  /** review 模式的分流；Phase 1 不使用 machine/human，保留字段供 Phase 2 */
  review: ReviewTier;
  /** 本机会话 HOME 外路径门是否覆盖此工具 */
  localPathGated: boolean;
  /** allow_always 的默认作用域 */
  ruleScope: RuleScope;
}

/** 外部工具（MCP/扩展）与未知内置工具的安全回退：人工，不参与自动放行。 */
const EXTERNAL_TOOL_POLICY: ToolPolicy = {
  capabilities: ["external"],
  execution: "external",
  planReadonly: false,
  ask: "ask",
  acceptEdits: "ask",
  review: "human",
  localPathGated: false,
  ruleScope: "tool",
};

/** 只读工具在 ask/acceptEdits/review 下都免批。 */
function readPolicy(ruleScope: RuleScope, localPathGated = false, execution: ToolExecutionClass = "read_only"): ToolPolicy {
  return {
    capabilities: ["read"],
    execution,
    planReadonly: true,
    ask: "auto",
    acceptEdits: "auto",
    review: "machine",
    localPathGated,
    ruleScope,
  };
}

/** 内部低风险工具（任务清单、记忆、看板等）：三档均免批。 */
function internalPolicy(capabilities: readonly ToolCapability[], planReadonly: boolean, execution: ToolExecutionClass): ToolPolicy {
  return {
    capabilities,
    execution,
    planReadonly,
    ask: "auto",
    acceptEdits: "auto",
    review: "machine",
    localPathGated: false,
    ruleScope: "tool",
  };
}

const BUILTIN_TOOL_POLICIES = {
  // 文件与检索
  read_file: readPolicy("path-dir", true),
  read_media: readPolicy("path-dir", true),
  read_artifact: readPolicy("tool"),
  glob: readPolicy("path-dir", true),
  grep: readPolicy("path-dir", true),
  load_skill: readPolicy("tool"),
  repo_map: readPolicy("tool"),
  code_search: readPolicy("tool"),
  git_status: readPolicy("tool"),
  git_diff: readPolicy("tool"),

  // 写入/编辑：acceptEdits 自动；review 在 Phase 1 仍走模型，Phase 2 改为自动。
  write_file: {
    capabilities: ["write"],
    execution: "workspace_write",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "auto",
    review: "machine",
    localPathGated: true,
    ruleScope: "path-dir",
  },
  edit_file: {
    capabilities: ["write"],
    execution: "workspace_write",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "auto",
    review: "machine",
    localPathGated: true,
    ruleScope: "path-dir",
  },

  // 执行
  bash: {
    capabilities: ["exec"],
    execution: "process",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "command-prefix",
  },
  test_runner: {
    capabilities: ["exec"],
    execution: "process",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "tool",
  },

  // 联网
  web_fetch: {
    capabilities: ["network"],
    execution: "external",
    planReadonly: true,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "origin",
  },
  web_search: {
    capabilities: ["network"],
    execution: "external",
    planReadonly: true,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "tool",
  },

  // 交互
  ask_user: internalPolicy(["internal"], true, "read_only"),
  exit_plan_mode: internalPolicy(["internal"], true, "read_only"),

  // 编排：子代理内部有各自的权限链，启动本身三档免批。
  subagent: internalPolicy(["orchestrate"], true, "process"),
  spawn_task: internalPolicy(["orchestrate"], true, "process"),
  spawn_swarm: internalPolicy(["orchestrate"], true, "process"),
  swarm_board_read: readPolicy("tool"),
  swarm_board_post: internalPolicy(["write"], false, "read_only"),
  swarm_wait: {
    capabilities: ["orchestrate"],
    execution: "workspace_write",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "tool",
  },

  // 任务/定时
  task_output: readPolicy("tool"),
  task_stop: {
    capabilities: ["internal"],
    execution: "process",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "tool",
  },
  todo_write: internalPolicy(["internal"], true, "workspace_write"),
  remember: internalPolicy(["write"], false, "workspace_write"),
  cron_create: internalPolicy(["internal"], false, "read_only"),
  cron_list: internalPolicy(["internal"], true, "read_only"),
  cron_delete: internalPolicy(["internal"], false, "read_only"),

  // Git 写操作：commit 特殊（yolo 也不隐含提交授权），其余按普通执行。
  git_commit: {
    capabilities: ["exec"],
    execution: "process",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "ask",
    review: "human",
    localPathGated: false,
    ruleScope: "tool",
  },
  git_worktree_create: {
    capabilities: ["exec"],
    execution: "process",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "tool",
  },
  git_worktree_remove: {
    capabilities: ["exec"],
    execution: "process",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "tool",
  },
  git_worktree_merge: {
    capabilities: ["exec"],
    execution: "process",
    planReadonly: false,
    ask: "ask",
    acceptEdits: "ask",
    review: "model",
    localPathGated: false,
    ruleScope: "tool",
  },
} satisfies Record<string, ToolPolicy>;

/** 外部工具（MCP/扩展）判定。 */
function isExternalTool(tool: string): boolean {
  return tool.startsWith("mcp__") || tool.startsWith("ext__");
}

/** 查表；未知内置工具回退为 external（人工），绝不默认放行。 */
export function policyForTool(tool: string): ToolPolicy {
  if (isExternalTool(tool)) return EXTERNAL_TOOL_POLICY;
  const policy = (BUILTIN_TOOL_POLICIES as Record<string, ToolPolicy>)[tool];
  return policy ?? EXTERNAL_TOOL_POLICY;
}

/** 调度分类查询；未登记工具与历史行为一致回退 workspace_write。 */
export function executionClassForTool(tool: string): ToolExecutionClass {
  if (isExternalTool(tool)) return "external";
  const policy = (BUILTIN_TOOL_POLICIES as Record<string, ToolPolicy>)[tool];
  return policy?.execution ?? "workspace_write";
}

export function isPlanReadonlyTool(tool: string): boolean {
  return policyForTool(tool).planReadonly;
}

export function isLocalPathGatedTool(tool: string): boolean {
  return policyForTool(tool).localPathGated;
}

/** 合并会话与全局放行规则：会话规则在前（同名规则优先命中），全局规则只补充。 */
export function mergePermissionRules(
  sessionRules: readonly PermissionRule[] | undefined,
  globalRules: readonly PermissionRule[] | undefined,
): PermissionRule[] {
  return [...(sessionRules ?? []), ...(globalRules ?? [])];
}

/**
 * allow_always 规则生成。语义与历史保持一致：
 * - bash 落完整命令前缀；
 * - 文件工具落目录（read_file/write_file/edit_file 取 dirname，glob/grep 的 path 本身是目录）；
 * - web_fetch 落 origin；
 * - 其余整工具。
 */
export function permissionRule(tool: string, input: Record<string, unknown>): PermissionRule {
  if (tool === "bash" && typeof input.cmd === "string") return { tool, argumentPrefix: input.cmd };
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
 * bash 规则的词边界前缀匹配：`npm test` 规则放行 `npm test -- --watch`，
 * 不放行 `npm testx`。前缀之后的剩余串若含 shell 控制元字符（管道/连接/重定向/
 * 命令替换/换行）则不适用前缀语义，回退整串精确——否则「总是允许 npm test」
 * 会连带放行 `npm test && curl evil`。
 */
// \r 必须在列：cmd.exe 把孤立 CR 当行终止符，「npm test \rwhoami」会执行两条命令
const SHELL_CONTROL_CHARS = /[&|;><`\n\r]|\$\(/;
export function matchesBashCommandPrefix(prefix: string, value: string): boolean {
  if (value === prefix) return true;
  if (!value.startsWith(`${prefix} `)) return false;
  return !SHELL_CONTROL_CHARS.test(value.slice(prefix.length + 1));
}

export function matchesRule(rule: PermissionRule, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  if (rule.argumentPrefix === undefined) return true;
  if (tool === "web_fetch") {
    if (typeof input.url !== "string") return false;
    try { return new URL(input.url).origin === rule.argumentPrefix; } catch { return false; }
  }
  const value = tool === "bash" ? input.cmd : input.path;
  if (typeof value !== "string") return false;
  if (tool === "bash") return matchesBashCommandPrefix(rule.argumentPrefix, value);
  return value === rule.argumentPrefix || value.startsWith(`${rule.argumentPrefix}/`);
}
