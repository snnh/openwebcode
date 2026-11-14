import type { PermissionMode, PermissionRule } from "../sessions/types.js";
import { classifyBash, classifyTestRunner, type BashSandboxContext } from "./bash-risk.js";
import type { ReadonlyShellFlavor } from "./readonly-command.js";
import { isPlanReadonlyTool, matchesRule, policyForTool } from "./tool-policy.js";

/**
 * 单权限策略引擎：只负责「在当前档位/规则/沙盒上下文中，这次调用是否需要人工、
 * 模型或直接放行」。
 *
 * 计划模式门禁单独由 planGateDecision() 提供：authorizeTool 必须先过计划门禁，
 * 再做本机会话路径门与路径归一化，最后才调用 decidePermission()（规则需要匹配
 * 归一化后的路径）。
 */

type PermissionOutcome = "allow" | "review" | "ask" | "deny";
type PermissionSource = "plan" | "rule" | "machine" | "model" | "human" | "mode";

export interface PermissionEngineDecision {
  outcome: PermissionOutcome;
  source: PermissionSource;
  tier?: "machine" | "model" | "human";
  rule?: PermissionRule;
  reason?: string;
}

export interface PermissionEngineInput {
  mode: PermissionMode;
  tool: string;
  input: Record<string, unknown>;
  rules: readonly PermissionRule[];
  shellFlavor?: ReadonlyShellFlavor;
  /** 会话生效沙盒（用于只读快道路径范围与构建/测试快道）。 */
  sandbox?: BashSandboxContext;
  /** 内置基线之外的追加项（全局 + 会话）。 */
  highRisk?: { commands?: readonly string[]; tools?: readonly string[] };
}

/** 计划模式门禁；返回 undefined 表示允许继续走普通权限链。 */
export function planGateDecision(tool: string): PermissionEngineDecision | undefined {
  if (isPlanReadonlyTool(tool)) return undefined;
  if (tool.startsWith("mcp__")) {
    return {
      outcome: "deny",
      source: "plan",
      reason: `Plan 模式为只读：MCP 工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 code 模式执行。`,
    };
  }
  if (tool.startsWith("ext__")) {
    return {
      outcome: "deny",
      source: "plan",
      reason: `Plan 模式为只读：扩展工具 ${tool} 被拦截（无法判定读写）。请输出实施计划并请用户切换到 code 模式执行。`,
    };
  }
  return {
    outcome: "deny",
    source: "plan",
    reason: `Plan 模式为只读：${tool} 被拦截。请输出实施计划并请用户切换到 code 模式执行。`,
  };
}

function modeAutoAllows(mode: PermissionMode, policy: ReturnType<typeof policyForTool>): boolean {
  if (mode === "ask") return policy.ask === "auto";
  if (mode === "acceptEdits") return policy.acceptEdits === "auto";
  if (mode === "review") return policy.review === "machine";
  return true;
}

/**
 * 普通权限判定。调用方必须已经通过 planGateDecision()。
 *
 * 判定顺序：
 * 1. allow 规则（显式规则可覆盖高危分类）；
 * 2. 追加高危工具（yolo 除外，强制人工）；
 * 3. git_commit 永远需要显式规则（yolo 也不例外）；
 * 4. yolo；
 * 5. bash 三档（机器/人工/模型）；
 * 6. review 下的 test_runner 三档；
 * 7. 档位工具表（ask/acceptEdits/review）；
 * 8. ask/acceptEdits 转人工，review 按 human/model 分流。
 */
export function decidePermission(input: PermissionEngineInput): PermissionEngineDecision {
  const { mode, tool, input: toolInput, rules } = input;
  const policy = policyForTool(tool);
  const highRisk = input.highRisk;

  const rule = rules.find((candidate) => matchesRule(candidate, tool, toolInput));
  if (rule) return { outcome: "allow", source: "rule", rule };

  if (mode !== "yolo" && highRisk?.tools?.includes(tool)) {
    return { outcome: "ask", source: "human", tier: "human", reason: "命中追加高危工具清单" };
  }

  // git_commit 默认不开放给 agent 自动执行：yolo 也不隐含提交授权。
  if (tool === "git_commit") return { outcome: "ask", source: "human", tier: "human" };

  if (mode === "yolo") return { outcome: "allow", source: "mode" };

  // bash：只读链/构建测试可机器放行；高危人工；其余 review 走模型。
  if (tool === "bash") {
    const cmd = typeof toolInput.cmd === "string" ? toolInput.cmd : "";
    const classified = classifyBash(cmd, input.shellFlavor ?? "sh", input.sandbox, highRisk?.commands ?? []);
    if (classified.risk === "low") return { outcome: "allow", source: "machine", tier: "machine" };
    if (mode === "review" && classified.risk === "unknown") return { outcome: "review", source: "model", tier: "model" };
    return {
      outcome: "ask",
      source: "human",
      tier: "human",
      ...(classified.reasons.length > 0 ? { reason: classified.reasons.join("; ") } : {}),
    };
  }

  if (tool === "test_runner" && mode === "review") {
    const classified = classifyTestRunner(toolInput.command, input.sandbox, highRisk?.commands ?? []);
    if (classified.risk === "low") return { outcome: "allow", source: "machine", tier: "machine" };
    if (classified.risk === "high") {
      return { outcome: "ask", source: "human", tier: "human", ...(classified.reasons.length > 0 ? { reason: classified.reasons.join("; ") } : {}) };
    }
    return { outcome: "review", source: "model", tier: "model" };
  }

  if (modeAutoAllows(mode, policy)) return { outcome: "allow", source: "machine", tier: "machine" };

  if (mode === "ask" || mode === "acceptEdits") {
    return { outcome: "ask", source: "human", tier: "human" };
  }

  // review
  if (policy.review === "human") return { outcome: "ask", source: "human", tier: "human" };
  return { outcome: "review", source: "model", tier: "model" };
}
