export interface ContextSegmentBreakdown {
  /** 系统提示词侧（含 repoMap 段归因）。 */
  system: number;
  /** 用户输入（user 角色消息）。 */
  input: number;
  /** 工具调用（tool_call 块 + tool 角色的 tool_result 块）。 */
  toolCalls: number;
  /** 模型正式输出（assistant 的 text 块）。 */
  output: number;
  /** 其它（thinking 块、压缩摘要头与未归类）。 */
  other: number;
}

export interface ContextBuildStats {
  totalTokens: number;
  segments: ContextSegmentBreakdown;
  pinnedTokens: number;
  buildMs: number;
  incremental: boolean;
  /** 当前驱逐态工具结果聚合（原文估算 tokens + 条数）；无驱逐条目时缺省（旧 server 不返回）。 */
  evicted?: { tokens: number; count: number };
}

/** WS 事件 context.watermark 的 payload：每轮 agent 结束后上报的实时上下文窗口水位。 */
export interface ContextWatermark {
  estimatedTokens: number;
  contextWindow: number;
  workingBudget: number;
  utilization: number;
  warning?: "force_compact" | "compact_recommended";
  segments: ContextSegmentBreakdown;
  pinnedTokens: number;
  buildMs: number;
  incremental: boolean;
  pinWarning?: string;
}

/** 一组 token 用量计数。Anthropic 口径：inputTokens 为未缓存输入，总输入 = inputTokens + cacheRead。 */
export interface ContextTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

/** WS 事件 context.usage 的 payload：每次 provider API 调用后的本轮 token 用量与成本。 */
export interface ContextUsage extends ContextTokenUsage {
  cost?: {
    priced: boolean;
    source?: { currency: string; amount: number };
    usd?: number;
    cny?: number;
  };
  sessionCost?: { usdMicroUnits: string; cnyMicroUnits: string; unpricedTokens: number };
}

export interface ContextView {
  stats?: ContextBuildStats;
  selection?: { pins: string[]; excludes: string[] };
  ledger: {
    round?: number;
    usage: ContextTokenUsage;
    cost: { usdMicroUnits: string; cnyMicroUnits: string; unpricedTokens: number };
    entries: Array<{ messageId: string; state: "full" | "evicted" | "restored"; artifactId: string; pinnedUntilRound?: number }>;
    policy?: {
      enabled: boolean;
      strategy: "lag" | "interval" | "off";
      evictionMode: "placeholder" | "process";
      lag: number;
      interval: number;
      minRetainTokens: number;
      readKeepLines: number;
      pinExemptRounds: number;
      restoreBudget: number;
      maxSessionTokens?: number;
      maxSessionCost?: { currency: "USD" | "CNY"; microUnits: string };
    };
    compacted?: { uptoIndex: number; mode: "toolcalls" | "overview" | "truncated" | "vault"; summary: string; instructions: string[]; createdAt: string; replacedTokens?: number };
    /** 历次压缩记录（含最新一次，与 compacted 末条同义）：供消息流还原多个压缩检查点；旧 server 缺省。 */
    compactionHistory?: Array<{ uptoIndex: number; mode: "toolcalls" | "overview" | "truncated" | "vault"; summary: string; instructions: string[]; createdAt: string; replacedTokens?: number }>;
    /** 最近记录的 prompt cache 消息级断点（消息 id）；诊断用。 */
    cacheBreakpoints?: string[];
    cleared?: { uptoIndex: number; at: string; uptoMessageId?: string };
  };
  preferences: { language: string; currency: "USD" | "CNY"; currencyLabel: string };
}
