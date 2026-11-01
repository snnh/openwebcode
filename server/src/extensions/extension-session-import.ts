import { ContextManager } from "../context/context-manager.js";
import type { SessionStore } from "../sessions/session-store.js";
import { sanitizeImportLedger } from "./import-ledger.js";
import { publicSessionMeta } from "./session-projection.js";

export interface SessionImportDeps {
  sessions: SessionStore;
  /** 缺省 provider/model 时按 owc 当前默认补全（与 POST /api/sessions 同语义）。 */
  resolveModelSelection?: (provider?: string) => { provider?: string; model?: string } | undefined;
}

/**
 * `sessions.import`：把扩展下发的 transfer 文本（或结构化 meta+messages）写成会话，
 * 可选落盘账本与子代理转录；返回投影后的会话元信息与子代理写入结论。
 */
export async function importSession(deps: SessionImportDeps, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { sessions } = deps;
  // 两种入参形态（M3a 的现成文本 / M3b 的结构化 meta+messages），统一收敛为 transfer 文本后走同一路径：
  // 结构化形态让扩展不必自己拼 JSONL，也免得扩展侧漏掉 meta 必填字段的净化口径。
  const text = sessionImportText(deps, params);
  const replaceId = typeof params.replaceId === "string" ? params.replaceId : undefined;
  // 两种语义：无 replaceId = 新建导入（原 id 未被占用则沿用）；带 replaceId = 覆盖目标会话历史。
  const meta = replaceId === undefined
    ? await sessions.importJsonl(text)
    : await sessions.replaceJsonl(replaceId, text);
  // 可选账本：导入方（扩展宿主的会话转换器）把 dsh compaction/summary 映射出的 compacted
  // 一起落盘，省掉一次往返；缺省时账本懒建为空（round:0 最小账本由 normalizer 兜底）。
  // ledger 来自扩展（可能直接把外部文件的 JSON 塞进来）：落盘前先限形 + 限量（summary 截断、
  // compactionHistory/entries 封顶、条目字段白名单），不合账本形状就整个不落（宁缺勿脏）。
  const ledger = sanitizeImportLedger(params.ledger);
  if (ledger !== undefined) {
    await new ContextManager(sessions.contextRoot(meta.id)).replaceLedger(ledger);
  }
  // M5a：子代理转录落盘（<sessionDir>/subagents/<taskId>.json）。逐项 try：单项坏数据
  // （非法 taskId、缺字段、写盘失败）只记 subagentsFailed，不中断本次导入。
  const subagentsFailed: Array<{ taskId: string; reason: string }> = [];
  let subagentsWritten = 0;
  for (const [index, raw] of (Array.isArray(params.subagents) ? params.subagents : []).entries()) {
    const entry = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const taskId = typeof entry?.taskId === "string" ? entry.taskId : "";
    const data = entry?.data !== null && typeof entry?.data === "object" && !Array.isArray(entry?.data)
      ? entry.data as Record<string, unknown>
      : undefined;
    try {
      if (taskId.length === 0) throw new Error("subagents 条目需要 taskId");
      if (data === undefined) throw new Error("subagents 条目需要 data 对象");
      subagentsWritten += await sessions.importSubagentTranscripts(meta.id, [{ taskId, data }]);
    } catch (error: unknown) {
      subagentsFailed.push({ taskId: taskId.length > 0 ? taskId : `#${index}`, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ...publicSessionMeta(meta),
    subagentsWritten,
    ...(subagentsFailed.length === 0 ? {} : { subagentsFailed }),
  };
}

/**
 * `sessions.import` 入参 → 会话 transfer 文本（首行 meta + 每行一条消息，见 session-transfer.ts）。
 *
 * 支持两种形态：
 * 1. `{text}`（M3a 现状）：原样返回，交给 `parseSessionImport` 校验；
 * 2. `{meta:{cwd,title,createdAt?,provider?,model?}, messages:[...]}`（M3b 结构化）：在这里组装首行
 *    `{kind:"meta",version:1,exportedAt,session:{...}}`，messages 逐条 `JSON.stringify` 拼行。
 *
 * 模型归属：meta 未给 provider/model 时按 owc 当前默认（settings.defaultModel → 首个已配置服务商 /
 * 目录首模型，与 `POST /api/sessions` 的隐式解析同语义）补默认；provider 仍解析不出来即报
 * 「无可用服务商配置」——导入的会话必须可继续对话，没有 provider 的会话落盘即是坏数据。
 *
 * 净化/校验一律交给 `SessionStore.importJsonl` 的既有兜底（信任边界只有一处）：本函数只做「拼装」，
 * 不挑选/裁剪消息字段，也不接受 meta 里的沙盒/权限/工作区字段。
 * @param params - 扩展下发的入参（`text` 或 `meta`+`messages`）。
 * @returns 可喂 `importJsonl`/`replaceJsonl` 的 transfer 文本。
 */
function sessionImportText(deps: SessionImportDeps, params: Record<string, unknown>): string {
  const rawText = typeof params.text === "string" ? params.text : "";
  if (rawText.trim().length > 0) return rawText;
  const rawMeta = params.meta;
  if (rawMeta === null || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
    throw new Error("sessions.import requires non-empty text");
  }
  const meta = rawMeta as Record<string, unknown>;
  const cwd = typeof meta.cwd === "string" ? meta.cwd.trim() : "";
  if (cwd.length === 0) throw new Error("sessions.import requires meta.cwd");
  if (!Array.isArray(params.messages)) throw new Error("sessions.import requires messages to be an array");
  // title 是 parseSessionImport 的必填非空字段：扩展没给标题时补一个稳定占位（面板里可随手改名），
  // 而不是整条导入失败。
  const title = typeof meta.title === "string" && meta.title.trim().length > 0 ? meta.title.trim() : "导入的会话";
  const explicitProvider = typeof meta.provider === "string" && meta.provider.trim().length > 0 ? meta.provider.trim() : undefined;
  const explicitModel = typeof meta.model === "string" && meta.model.trim().length > 0 ? meta.model.trim() : undefined;
  const resolved = explicitProvider === undefined || explicitModel === undefined ? deps.resolveModelSelection?.() : undefined;
  const provider = explicitProvider ?? resolved?.provider;
  if (provider === undefined || provider.length === 0) {
    throw new Error("无可用服务商配置：导入会话需要 provider（请在设置里配置模型服务商）");
  }
  // model 的归属必须与 provider 一致：显式给了 provider 时只采纳「同一 provider」的默认模型，
  // 否则宁可不带模型（新建会话允许 model 为空，用户进会话再选），也不把别的 provider 的模型写上。
  const sameProviderSelection = resolved !== undefined && (explicitProvider === undefined || resolved.provider === explicitProvider);
  const model = explicitModel ?? (sameProviderSelection ? resolved.model ?? "" : "");
  const head = {
    kind: "meta",
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      cwd,
      title,
      provider,
      model,
      ...(typeof meta.createdAt === "string" && meta.createdAt.length > 0 ? { createdAt: meta.createdAt } : {}),
    },
  };
  const lines = [JSON.stringify(head), ...params.messages.map((message) => JSON.stringify(message))];
  return `${lines.join("\n")}\n`;
}
