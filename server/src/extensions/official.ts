import { createHash } from "node:crypto";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { ContextHookPayload, ContextHookResult, ExtensionManifest } from "./types.js";

export const OFFICIAL_EXTENSIONS: ExtensionManifest[] = [
  {
    id: "context-manager",
    name: "上下文管理器",
    version: "0.2.0",
    description: "滚动驱逐、上下文压缩、回写与账本视图。",
    apiVersion: "1",
    permissions: ["context:read", "context:mutate", "ui:panel"],
    official: true,
    defaultEnabled: true,
  },
  {
    id: "attention-optimizer",
    name: "注意力优化器",
    version: "0.2.0",
    description: "复制关键约束和当前任务到上下文锚区，缓解 lost-in-the-middle。",
    apiVersion: "1",
    permissions: ["context:read", "context:mutate", "ui:panel"],
    official: true,
    defaultEnabled: false,
  },
  {
    id: "content-lens",
    name: "内容透镜",
    version: "0.2.0",
    description: "提供不进入模型上下文的消息翻译与选中文本解析。",
    apiVersion: "1",
    permissions: ["sessions:read", "ui:panel", "ui:messageAttachment", "network:fetch"],
    official: true,
    defaultEnabled: false,
  },
  {
    id: "pdf-to-image",
    name: "PDF 转图片",
    version: "0.2.0",
    description: "将 PDF 页面转换为图片附件，供支持图片输入的模型读取。",
    apiVersion: "1",
    // The conversion is a Composer-side attachment feature; it needs no
    // session, network, tool, or context access in the Extension Host.
    permissions: ["ui:messageAttachment"],
    official: true,
    defaultEnabled: true,
  },
];

export const OFFICIAL_DEFAULT_CONFIG: Record<string, Record<string, unknown>> = {
  "context-manager": {},
  "attention-optimizer": { mode: "bottomOnly", anchorBudget: 3000 },
  "content-lens": {
    targetLang: "zh-CN",
    translate: { mode: "manual", layout: "sideBySide", glossary: {} },
    explain: { webSearch: true, searchProvider: "host" },
  },
  "pdf-to-image": { maxPages: 4, dpi: 150, maxDimension: 2048 },
};

function textOf(message: ChatMessage): string {
  return message.content
    .filter((block): block is Extract<MessageContent, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** 规则评分：明确约束/目标/错误/pin 优先；只复制引用，不移动原消息。 */
export function optimizeAttention(payload: ContextHookPayload, config: Record<string, unknown>): ContextHookResult {
  const rawBudget = Number(config.anchorBudget ?? 3000);
  const budget = Number.isFinite(rawBudget) ? Math.max(256, Math.min(12_000, Math.floor(rawBudget))) : 3000;
  const mode = config.mode === "full" ? "full" : "bottomOnly";
  const pinned = new Set(payload.ledger.entries.filter((entry) => entry.pinnedUntilRound >= payload.ledger.round).map((entry) => entry.messageId));
  const candidates = payload.messages
    .map((message, index) => {
      const text = textOf(message);
      let score = message.role === "user" ? 20 : 0;
      if (/必须|不要|禁止|始终|要求|约束|目标|must|never|always|require/i.test(text)) score += 40;
      if (/错误|失败|异常|error|failed|exception/i.test(text)) score += 20;
      if (pinned.has(message.id)) score += 30;
      score += Math.max(0, 10 - (payload.messages.length - index));
      return { message, text, score, index };
    })
    .filter((item) => item.text && item.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index);
  const lines: string[] = [];
  let used = 0;
  for (const item of candidates) {
    const line = `- [${item.message.role}:${item.message.id}] ${clip(item.text.replace(/\s+/g, " "), 360)}`;
    if (used + line.length > budget) continue;
    lines.push(line);
    used += line.length;
    if (lines.length >= 12) break;
  }
  if (lines.length === 0) return {};
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
  const bottom: ChatMessage = {
    id: `extension:attention:bottom:${digest}`,
    role: "user",
    createdAt: new Date(0).toISOString(),
    content: [{ type: "text", text: `[Attention anchor — references copied from earlier messages; preserve original chronology]\n${lines.join("\n")}` }],
  };
  const messages = [...payload.messages, bottom];
  if (mode === "full") {
    const constraints = payload.ledger.compacted?.instructions ?? lines.slice(0, 5).map((line) => line.replace(/^- \[[^\]]+\]\s*/, ""));
    if (constraints.length > 0) {
      messages.unshift({
        id: `extension:attention:top:${digest}`,
        role: "user",
        createdAt: new Date(0).toISOString(),
        content: [{ type: "text", text: `[Stable constraint anchor]\n${constraints.map((item) => `- ${item}`).join("\n")}` }],
      });
    }
  }
  return { messages, metadata: { extension: "attention-optimizer", mode, estimatedExtraTokens: Math.ceil(used / 4), digest } };
}
