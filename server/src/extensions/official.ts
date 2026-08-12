import { createHash } from "node:crypto";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { ContextHookPayload, ContextHookResult, ExtensionManifest } from "./types.js";

export const OFFICIAL_EXTENSIONS: ExtensionManifest[] = [
  {
    id: "context-manager",
    name: "上下文管理器",
    version: "0.2.3",
    description: "滚动驱逐、上下文压缩、回写与账本视图。",
    apiVersion: "1",
    permissions: ["context:read", "context:mutate", "ui:panel"],
    official: true,
    defaultEnabled: true,
  },
  {
    id: "attention-optimizer",
    name: "注意力优化器",
    version: "0.2.3",
    description: "复制关键约束和当前任务到上下文锚区，缓解 lost-in-the-middle。",
    apiVersion: "1",
    permissions: ["context:read", "context:mutate", "ui:panel"],
    official: true,
    defaultEnabled: false,
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["bottomOnly", "full"],
          title: "锚区模式",
          description: "bottomOnly 只在消息末尾追加引用锚区；full 额外在开头注入稳定约束锚区，效果更好但占用更多上下文。",
          default: "bottomOnly",
        },
        anchorBudget: {
          type: "integer",
          minimum: 256,
          maximum: 12000,
          title: "锚区预算（字符）",
          description: "锚区可复制内容的字符上限；超出按评分截断。消费端会钳制在 256–12000。",
          default: 3000,
        },
      },
    },
  },
  {
    id: "content-lens",
    name: "内容透镜",
    version: "0.2.3",
    description: "提供不进入模型上下文的消息翻译与选中文本解析。",
    apiVersion: "1",
    permissions: ["sessions:read", "ui:panel", "ui:messageAttachment", "network:fetch"],
    official: true,
    defaultEnabled: false,
    // 顶层之外的存量键（translate.layout、explain.*）目前无消费端，schema 不递归校验，
    // additionalProperties 保持宽容以免旧配置保存被拒。
    configSchema: {
      type: "object",
      properties: {
        targetLang: {
          type: "string",
          title: "目标语言",
          description: "翻译与解析的输出语言，如 zh-CN、en、ja。",
          default: "zh-CN",
        },
        translate: {
          type: "object",
          title: "翻译",
          description: "消息翻译的触发方式与术语表。",
          properties: {
            mode: {
              type: "string",
              enum: ["manual", "auto", "off"],
              title: "触发方式",
              description: "manual 点击「译」按钮翻译；auto 助手消息自动翻译；off 关闭翻译入口。",
              default: "manual",
            },
            glossary: {
              type: "object",
              additionalProperties: { type: "string" },
              title: "术语表",
              description: "固定译法，每行一条「原词=译词」。",
            },
          },
        },
      },
    },
  },
  {
    id: "pdf-to-image",
    name: "PDF 转图片",
    version: "0.2.3",
    description: "将 PDF 页面转换为图片附件，供支持图片输入的模型读取。",
    apiVersion: "1",
    // The conversion is a Composer-side attachment feature; it needs no
    // session, network, tool, or context access in the Extension Host.
    permissions: ["ui:messageAttachment"],
    official: true,
    defaultEnabled: true,
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxPages: {
          type: "integer",
          minimum: 1,
          title: "最大转换页数",
          description: "每次最多转换的 PDF 页数，另受单次附件数量上限约束。",
          default: 4,
        },
        dpi: {
          type: "integer",
          minimum: 72,
          maximum: 300,
          title: "渲染 DPI",
          description: "页面渲染分辨率；越高越清晰，图片也越大。上限 300。",
          default: 150,
        },
        maxDimension: {
          type: "integer",
          minimum: 512,
          maximum: 2048,
          title: "最长边（像素）",
          description: "输出图片最长边像素上限，超出按比例缩小。上限 2048。",
          default: 2048,
        },
      },
    },
  },
  {
    id: "owc-eval",
    name: "评测 Harness",
    version: "0.5.0",
    description: "任务集回放与回归对比：通过率、工具选择、token/耗时报告。",
    apiVersion: "1",
    // UI visibility + independent enable/disable only. The eval service runs
    // server-side via the built-in eval module, not through the Extension Host
    // hook mechanism.
    permissions: ["sessions:read", "ui:panel"],
    official: true,
    defaultEnabled: false,
  },
  {
    id: "env-sim",
    name: "环境模拟",
    version: "0.1.0",
    description: "启用后按选定预设模仿其他编码 Agent 的系统提示词风格与默认工具形态。",
    apiVersion: "1",
    // 提示词变换与工具形态都在 server 侧直接执行（预设数据与用户预设目录是 server
    // 本地状态），不经 Extension Host IPC；因此无需任何扩展权限。
    permissions: [],
    official: true,
    defaultEnabled: false,
    // persona 枚举是动态的（内置 + 用户目录发现），不在 schema 写死；可用列表经
    // ExtensionInfo.availablePersonas / GET /api/extensions/env-sim/personas 暴露。
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        persona: { type: "string", title: "预设", description: "选择要模拟的编码 Agent 预设；留空表示不模拟。", default: "" },
      },
    },
  },
  {
    id: "compact-vault",
    name: "上下文档案库",
    version: "0.1.0",
    description: "压缩时把完整上下文归档到会话 compact/ 目录，上下文只留目录式索引；主模型可按 key 经快速模型召回细节。",
    apiVersion: "1",
    // 归档与整理在 server 侧执行（CompactVaultService）；recall_memory 工具与索引回注在
    // Extension Host 侧（context.readVaultFile 读归档文件，model.complete 走快速模型）。
    permissions: ["context:read", "context:mutate", "tools:register", "model:fast"],
    official: true,
    defaultEnabled: false,
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        keepTail: { type: "integer", minimum: 0, title: "保留尾部消息数", description: "压缩时保留的最近消息条数，不参与归档。", default: 10 },
        chunkSize: { type: "integer", minimum: 1, maximum: 200, title: "归档分块消息数", description: "每个归档分块包含的消息条数；分块越小索引越细，归档文件越多。", default: 25 },
        maxTokens: { type: "integer", minimum: 128, title: "整理输出上限（tokens）", description: "Pass 1/Pass 2 单次快速模型输出上限；留空不限制（端点默认）。思考型模型思考链较长，遇到输出为空请留空或调大。" },
        recallMaxTokens: { type: "integer", minimum: 128, maximum: 4096, title: "召回输出上限（tokens）", description: "recall_memory 单次召回细节的最大 token 数。", default: 4096 },
      },
    },
  },
  {
    id: "vision-tools",
    name: "视觉工具",
    version: "0.1.0",
    description: "主模型不支持视觉时，自动把会话图片交给配置的视觉模型生成描述，以文本形式注入上下文；支持视觉的主模型不受影响。",
    apiVersion: "1",
    // 图片描述在 server 侧执行（model.vision 复用 provider streamChat 发送链路）；替换注入在
    // Extension Host 侧（context.beforeBuild 钩子，storage 缓存描述结果）。
    permissions: ["context:read", "context:mutate", "model:fast"],
    official: true,
    defaultEnabled: false,
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        model: { type: "string", title: "视觉模型", description: "用于描述图片的模型（下拉列出已启用服务商中支持图片输入的模型）。", "x-model-picker": true },
        prompt: { type: "string", title: "描述提示词", description: "发给视觉模型的描述指令，可自定义语言与重点；留空使用默认提示词。", default: "" },
        thinking: { type: "boolean", title: "思考", description: "视觉模型思考模式（默认开启，描述更准确）。", default: true },
        maxTokens: { type: "integer", minimum: 128, title: "输出上限（tokens）", description: "单张图片描述的最大输出 token 数；留空不限制（端点默认）。" },
        cacheDescriptions: { type: "boolean", title: "缓存图片描述", description: "同一图片只描述一次，之后复用缓存（按图片内容哈希）。", default: true },
      },
      required: ["model"],
    },
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
  "owc-eval": {},
  "env-sim": { persona: "" },
  "compact-vault": { keepTail: 10, chunkSize: 25, recallMaxTokens: 4096 },
  "vision-tools": { model: "", prompt: "", thinking: true, cacheDescriptions: true },
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
