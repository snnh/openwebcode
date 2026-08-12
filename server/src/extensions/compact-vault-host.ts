import type { ContextHookPayload, ContextHookResult } from "./types.js";

/**
 * compact-vault 官方扩展的 Extension Host 侧实现（host 进程自包含，不依赖 server 模块）：
 * - recall_memory 工具：主模型按目录 key 召回归档片段，经快速模型提炼后返回；
 * - context.beforeBuild 钩子：非 vault 压缩（如 85% 强制 overview）覆盖索引后回注目录索引，
 *   保证 recall_memory 始终可用。
 * 归档写入与目录生成在 server 侧 CompactVaultService（app.ts runCompact 分支）。
 */

export interface VaultHostApi {
  /** context.readVaultFile：只读会话 compact/ 目录（server 侧路径锁定）。 */
  readVaultFile(sessionId: string, relative: string): Promise<{ content: string | null }>;
  /** model.complete：快速模型通道（prompt/maxTokens 上限由 server 强制）。 */
  modelComplete(input: { prompt: string; maxTokens?: number }): Promise<{ text: string }>;
}

export const RECALL_MEMORY_SPEC = {
  name: "recall_memory",
  description: "按 key 召回会话 compact/ 归档目录中的完整上下文片段（经快速模型提炼，删除过时内容）。key 来自上下文中的 [归档索引] 目录；多个 key 可一次召回。",
  inputSchema: {
    type: "object",
    properties: {
      keys: { type: "array", items: { type: "string" }, description: "目录条目 key 列表，如 [\"goals\", \"impl\"]" },
      query: { type: "string", description: "可选：想从归档中获得的具体信息，快速模型据此提炼" },
    },
    required: ["keys"],
  },
  // 召回会走快速模型提炼，默认 5s 的扩展工具超时不够，须显式调大
  timeoutMs: 60_000,
};

/** 目录条目（host 侧轻量视图，与 server 侧 VaultSection 同构）。 */
export interface VaultSectionLite {
  key: string;
  title: string;
  files: string[];
  desc: string;
}

export interface VaultIndexLite {
  uptoIndex: number;
  sections: VaultSectionLite[];
}

/** 解析 compact/index.json（容错：形状不合法返回 null）。 */
export function parseVaultIndexJson(raw: string): VaultIndexLite | null {
  try {
    const value = JSON.parse(raw) as { uptoIndex?: unknown; sections?: unknown };
    const uptoIndex = value.uptoIndex;
    if (typeof uptoIndex !== "number" || !Number.isSafeInteger(uptoIndex) || !Array.isArray(value.sections)) return null;
    const sections: VaultSectionLite[] = [];
    for (const section of value.sections) {
      if (!section || typeof section !== "object") continue;
      const record = section as { key?: unknown; title?: unknown; files?: unknown; desc?: unknown };
      if (typeof record.key !== "string" || typeof record.title !== "string") continue;
      sections.push({
        key: record.key,
        title: record.title,
        files: Array.isArray(record.files) ? record.files.filter((file): file is string => typeof file === "string") : [],
        desc: typeof record.desc === "string" ? record.desc : "",
      });
    }
    return { uptoIndex, sections };
  } catch {
    return null;
  }
}

/** 目录索引文本（与 server 侧 renderDirectoryIndex 同格式，host 自包含不复用）。 */
export function renderDirectoryLite(index: VaultIndexLite): string {
  const lines = [
    `[归档索引] 早前共 ${index.uptoIndex} 条消息已归档至会话 compact/ 目录。需要细节时调用 recall_memory(keys=[...]) 按 key 召回完整内容。`,
    ...index.sections.map((section) => `- ${section.title} (key=${section.key})：${section.desc}`),
  ];
  return lines.join("\n");
}

/** 字符预算内保头留尾（中文场景按字符计，保守兜住 model.complete 32 KiB prompt 上限）。 */
function clipToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}\n\n…[中间 ${text.length - budget} 字符省略]…\n\n${text.slice(-tail)}`;
}

function clampRecallMaxTokens(config: Record<string, unknown>): number {
  const raw = Number(config.recallMaxTokens ?? 1500);
  return Number.isFinite(raw) ? Math.min(4096, Math.max(128, Math.floor(raw))) : 1500;
}

/**
 * recall_memory 工具处理器：index.json 按 key 定位归档文件 → 读取片段（多文件按预算均分截取）
 * → 快速模型按查询提炼（失败降级返回原文片段）。
 */
export async function recallMemory(
  api: VaultHostApi,
  input: Record<string, unknown>,
  config: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<string> {
  if (!sessionId) throw new Error("recall_memory 需要会话上下文（sessionId 未透传）");
  const keys = Array.isArray(input.keys)
    ? input.keys.filter((key): key is string => typeof key === "string" && key !== "")
    : typeof input.keys === "string" && input.keys.trim() !== ""
      ? [input.keys]
      : [];
  if (keys.length === 0) throw new Error("recall_memory requires a non-empty keys array");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const indexRaw = await api.readVaultFile(sessionId, "index.json");
  if (!indexRaw?.content) throw new Error("会话没有 compact/ 归档。请先执行 /compact（启用档案库压缩后）");
  const index = parseVaultIndexJson(indexRaw.content);
  if (!index) throw new Error("compact/index.json 已损坏，无法召回");
  const byKey = new Map(index.sections.map((section) => [section.key, section]));
  const files = new Set<string>();
  const found: string[] = [];
  for (const key of keys) {
    const section = byKey.get(key);
    if (!section) continue;
    found.push(key);
    for (const file of section.files) if (file) files.add(file);
  }
  if (found.length === 0) {
    return `未找到归档条目 key：${keys.join(", ")}。可用 key：${index.sections.map((section) => section.key).join(", ") || "（无）"}`;
  }
  const fragments: string[] = [];
  for (const file of files) {
    const result = await api.readVaultFile(sessionId, file);
    if (result?.content) fragments.push(`### ${file}\n${result.content}`);
  }
  if (fragments.length === 0) throw new Error(`归档片段文件缺失（keys: ${found.join(", ")}）`);
  const maxTokens = clampRecallMaxTokens(config);
  // 片段字符预算：maxTokens*4 且 ≤ 20k 字符（多文件整体共享，超出保头留尾）
  const budget = Math.min(maxTokens * 4, 20_000);
  const combined = clipToBudget(fragments.join("\n\n"), budget);
  try {
    const completion = await api.modelComplete({
      prompt: `召回需求：${query || "概括以下归档内容中仍相关的事实与结论（删除过时信息）"}\n\n归档片段：\n${combined}`,
      maxTokens,
    });
    const text = completion.text.trim();
    return text !== "" ? text : combined;
  } catch {
    return `[快速模型提炼失败，返回原文片段]\n${combined}`;
  }
}

/**
 * context.beforeBuild 钩子：ledger 里已有压缩但 mode 非 vault（默认 overview/toolcalls 压缩覆盖了
 * 档案库索引）时，若磁盘存在归档则把目录索引回注为视图首条消息，保证 recall_memory 可用。
 */
export async function reinjectVaultIndex(api: VaultHostApi, payload: ContextHookPayload): Promise<ContextHookResult> {
  const compacted = payload.ledger?.compacted;
  if (!compacted || compacted.mode === "vault") return {};
  let raw: { content: string | null };
  try {
    raw = await api.readVaultFile(payload.sessionId, "index.json");
  } catch {
    return {};
  }
  if (!raw?.content) return {};
  const index = parseVaultIndexJson(raw.content);
  if (!index || index.sections.length === 0) return {};
  const digest = index.uptoIndex.toString(36);
  return {
    messages: [
      {
        id: `extension:vault:index:${digest}`,
        role: "user",
        createdAt: new Date(0).toISOString(),
        content: [{ type: "text", text: renderDirectoryLite(index) }],
      },
      ...payload.messages,
    ],
  };
}
