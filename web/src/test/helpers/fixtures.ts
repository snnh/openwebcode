import type { ContextView, LiveSubagentRun, ModelProfile, SessionDetail } from "../../lib/contracts";

/** 标准 s1 会话 fixture，overrides 逐字段覆盖。 */
export function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "s1",
    cwd: "/workspace/project",
    provider: "anthropic",
    model: "claude-opus-4-8",
    title: "测试作业",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: [], network: "deny" },
    messages: [],
    ...overrides,
  };
}

/** 标准 claude-opus-4-8 模型 fixture，overrides 逐字段覆盖。 */
export function makeModelProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: "claude-opus-4-8",
    provider: "anthropic",
    displayName: "Claude Opus 4.8",
    contextWindow: 128_000,
    capabilities: { thinking: ["adaptive", "disabled"], effort: ["low", "high"], modalities: ["text"], imageOutput: false, tools: true },
    ...overrides,
  };
}

/** 空账本 ContextView fixture，overrides 逐字段覆盖（浅合并顶层键）。 */
export function makeContextView(overrides: Partial<ContextView> = {}): ContextView {
  return {
    ledger: {
      usage: { inputTokens: 1_200, outputTokens: 80, cacheRead: 0, cacheWrite: 0 },
      cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
      entries: [],
    },
    preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" },
    ...overrides,
  } as ContextView;
}

/** LiveSubagentRun 工厂（subagent/subagents 系列测试共用）。 */
export function makeSubagentRun(overrides: Partial<LiveSubagentRun>): LiveSubagentRun {
  return {
    taskId: "task-1",
    toolCallId: "call-1",
    prompt: "调查代码结构",
    status: "running",
    turns: 0,
    toolsUsed: [],
    ...overrides,
  };
}
