/**
 * session-format-upgrade 官方扩展的服务端实现：通用会话格式升级框架。
 *
 * 设计（用户明确要求）：
 * - 手动触发：扩展默认关闭；启用后经 REST 端点逐个/全部触发，绝不自动改写历史；
 * - 触发即锁：升级期间对应会话不可使用（消息/重发入口 409），完成或失败后释放锁；
 * - 离线执行：路由层要求会话非运行中（agent.isRunning 为 false）才允许触发；
 * - 可回滚：升级前备份 messages.jsonl（backup 文件名返回给调用方），幂等可重复触发；
 * - 通用接口：升级步骤经 registerFormatUpgrade 注册（内置 responses-replay-fields / responses-text-signature
 *   步骤处理 OpenAI Responses 思维链回放字段与文本块 v1 textSignature），未来其他部分（压缩格式/ledger/快照等）升级
 *   时在扩展域新增步骤即可，主应用零改动——存储层只提供通用 transformMessages 原语，
 *   不感知任何具体升级逻辑，降低对主应用的破坏性。
 *
 * 依赖方向：本模块 → sessions（SessionStore.transformMessages）+ providers/responses-replay
 * （内置步骤的纯函数）；核心不得反向依赖本模块。
 */
import type { SessionStore } from "../sessions/session-store.js";
import type { ChatMessage } from "../sessions/types.js";
import { deriveMessageItemId, upgradeResponsesReplayFields } from "../providers/responses-replay.js";

/** 升级中的会话锁：触发即加锁，升级完成/失败后释放；锁定期内对应对话不可使用。 */
const upgradingSessions = new Set<string>();

/** 会话是否处于格式升级中（路由层在消息/重发入口检查，锁定期内拒绝使用）。 */
export function isSessionUpgrading(sessionId: string): boolean {
  return upgradingSessions.has(sessionId);
}

/** 单步升级结果。 */
interface FormatUpgradeStepResult {
  /** 变更的消息块数；0 = 该步骤无需升级（幂等）。 */
  changed: number;
  /** 升级前的备份文件名（会话目录内，与 messages.jsonl 同目录）；回滚 = 换回该文件。 */
  backup?: string;
}

/** 升级步骤声明：未来其他部分（消息格式/ledger/快照等）经 registerFormatUpgrade 登记，
 * 主应用与路由只调用通用执行接口（listFormatUpgrades / upgradeSessionFormat），
 * 不感知具体升级逻辑。 */
export interface FormatUpgradeStep {
  /** 步骤唯一 id（如 "responses-replay-fields"）；同 id 重复注册覆盖。 */
  id: string;
  /** 升级目标范围（当前仅消息 JSONL；未来可扩展 ledger/snapshot 等）。 */
  scope: "messages";
  /** 人类可读描述（列表接口与 UI 展示）。 */
  description: string;
  /** 执行单会话升级：必须幂等（重复执行 changed === 0），内部经
   * SessionStore.transformMessages 完成备份 + 原子写回 + 缓存失效。 */
  run: (store: SessionStore, id: string) => Promise<FormatUpgradeStepResult>;
}

/** 已注册升级步骤（id → step）。 */
const upgradeSteps = new Map<string, FormatUpgradeStep>();

/** 注册升级步骤（幂等：同 id 覆盖）。主应用其他部分在需要升级既有会话数据时调用。 */
export function registerFormatUpgrade(step: FormatUpgradeStep): void {
  upgradeSteps.set(step.id, step);
}

/** 列出全部已注册升级步骤（路由 GET 返回，供 UI/未来调用方发现可用升级）。 */
export function listFormatUpgrades(): Array<{ id: string; scope: string; description: string }> {
  return [...upgradeSteps.values()].map((step) => ({ id: step.id, scope: step.scope, description: step.description }));
}

/** 内置步骤：OpenAI Responses 思维链回放字段（thinking 块补 signature、tool_call 补
 * itemId），解决 DeepSeek 思维模式工具续轮 400。幂等；Anthropic thinking 块不碰。 */
registerFormatUpgrade({
  id: "responses-replay-fields",
  scope: "messages",
  description: "OpenAI Responses 思维链回放字段：thinking 块补 signature、tool_call 补 itemId（旧会话续跑 DeepSeek 思维模式 400 的修复前置）。",
  run: async (store, id) => {
    const result = await store.transformMessages(id, upgradeResponsesReplayFields);
    return { changed: result.changed, ...(result.backup ? { backup: result.backup } : {}) };
  },
});

/** 旧会话 assistant 文本块 → v1 textSignature（幂等）：为每个文本非空且尚无 textSignature
 * 的文本块固化 v1 message item 签名 {"v":1,"id":msg_...}（id 派生自 message id + 文本块
 * 序数，与回放端无签名时的派生兜底完全一致）。非文本块与已升级块不碰；重复执行 changed === 0。
 * 官方 OpenAI 加密思维链回放依赖 textSignature 还原 message item id/phase（phase 缺失时仅 id）。 */
export function upgradeResponsesTextSignatures(messages: readonly ChatMessage[]): { messages: ChatMessage[]; changed: number } {
  let changed = 0;
  const upgraded = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let textOrdinal = 0;
    const content = message.content.map((block) => {
      if (block.type !== "text") return block;
      const ordinal = textOrdinal;
      textOrdinal += 1;
      if (block.text.trim() === "" || block.textSignature !== undefined) return block;
      changed += 1;
      return {
        ...block,
        textSignature: JSON.stringify({ v: 1, id: deriveMessageItemId(`${message.id}:${ordinal}`) }),
      };
    });
    return content === message.content ? message : { ...message, content };
  });
  return { messages: upgraded, changed };
}

/** 内置步骤：OpenAI Responses 文本块 v1 textSignature（为旧会话文本块固化 v1 message id
 * 签名，官方 OpenAI 加密思维链回放的 message item id/phase 来源）。幂等；非文本块不碰。 */
registerFormatUpgrade({
  id: "responses-text-signature",
  scope: "messages",
  description: "OpenAI Responses 文本块 textSignature：为旧会话文本块固化 v1 message id 签名（官方 OpenAI 加密思维链回放的 message item id/phase 来源）。",
  run: async (store, id) => {
    const result = await store.transformMessages(id, upgradeResponsesTextSignatures);
    return { changed: result.changed, ...(result.backup ? { backup: result.backup } : {}) };
  },
});

export interface SessionFormatUpgradeResult {
  /** 执行的步骤 id 列表。 */
  steps: string[];
  /** 累计变更块数；0 = 无需升级（已是最新格式）。 */
  changed: number;
  /** 本次产生的备份文件名列表（会话目录内）。 */
  backups: string[];
}

/** 执行单个会话的指定/全部升级步骤：加锁 → 逐步骤执行 → 释放锁（失败也释放）。 */
export async function upgradeSessionFormat(
  store: SessionStore,
  id: string,
  stepId?: string,
): Promise<SessionFormatUpgradeResult> {
  if (upgradingSessions.has(id)) throw new Error("Session format upgrade is already in progress");
  upgradingSessions.add(id);
  try {
    const steps = stepId !== undefined
      ? [upgradeSteps.get(stepId)].filter((step): step is FormatUpgradeStep => step !== undefined)
      : [...upgradeSteps.values()];
    if (steps.length === 0) throw new Error(stepId !== undefined ? `Unknown format upgrade step: ${stepId}` : "No format upgrade steps registered");
    const executed: string[] = [];
    const backups: string[] = [];
    let changed = 0;
    for (const step of steps) {
      const result = await step.run(store, id);
      executed.push(step.id);
      changed += result.changed;
      if (result.backup) backups.push(result.backup);
    }
    return { steps: executed, changed, backups };
  } finally {
    upgradingSessions.delete(id);
  }
}

export interface SessionFormatUpgradeAllResult {
  /** 成功执行升级的会话数（至少一个步骤产生变更）。 */
  upgraded: number;
  /** 全部会话累计变更块数。 */
  total: number;
  /** 跳过的会话 id（运行中/锁定中）。 */
  skipped: string[];
  /** 升级失败的会话及其原因（单会话失败不中断整体；含损坏/IO 等诊断信息）。 */
  failed: Array<{ id: string; error: string }>;
  /** 本次产生的备份文件名列表。 */
  backups: string[];
}

/** 升级全部会话的指定/全部步骤：逐个离线升级；运行中/锁定中的会话跳过。 */
export async function upgradeAllSessions(
  store: SessionStore,
  isRunning: (sessionId: string) => boolean,
  stepId?: string,
): Promise<SessionFormatUpgradeAllResult> {
  const sessions = await store.list();
  let upgraded = 0;
  let total = 0;
  const skipped: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const backups: string[] = [];
  for (const meta of sessions) {
    if (isRunning(meta.id) || upgradingSessions.has(meta.id)) {
      skipped.push(meta.id);
      continue;
    }
    try {
      const result = await upgradeSessionFormat(store, meta.id, stepId);
      total += result.changed;
      if (result.changed > 0) {
        upgraded += 1;
        backups.push(...result.backups);
      }
    } catch (error) {
      // 单个会话升级失败不中断整体：记录原因（供调用方诊断）并继续（消息文件损坏等场景）
      failed.push({ id: meta.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { upgraded, total, skipped, failed, backups };
}
