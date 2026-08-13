import { createHash } from "node:crypto";
import type { ContextHookPayload, ContextHookResult } from "./types.js";

/**
 * vision-tools（视觉工具）官方扩展的 Extension Host 侧实现。
 *
 * 两种工作模式（config.mode）：
 * - describe（默认）：context.beforeBuild 钩子把会话图片逐张交给配置的视觉模型生成描述，
 *   以文本块替换 image 块注入上下文（server 侧 model.vision 复用 provider streamChat 链路）。
 * - toolCall：图片以 [图片 #N] 占位符进入上下文（N 为会话内稳定编号，按首次出现顺序分配，
 *   持久化于扩展 storage，跨轮/host 重启不变；/clear 清空上下文时旧图编号失效、编号表清空，
 *   之后重新从 #1 分配）；主模型按需调用 describe_image 工具
 *   （传 image 编号或工作区 path + request），视觉模型针对 request 回复。
 *   回复按「图片内容+request」哈希缓存到扩展私有 storage。
 *
 * 主模型支持视觉时两种模式都透传图片（直通质量更高）；未配置视觉模型、无图片的会话一律透传。
 * 安全纪律：单图描述失败必须吞错并替换为占位文本——钩子异常会让 server 回退原始 payload（含图片），
 * 纯文本主模型收到图片后 provider 请求会报错。
 */

export interface VisionToolsHostApi {
  /** 会话元信息（provider/model 判断主模型视觉能力）。 */
  getSession(sessionId: string): Promise<{ provider?: string; model?: string }>;
  /** 模型能力查询（modalities 含 image 判定）。 */
  getCapabilities(model: string): Promise<{ vision: boolean }>;
  /** 图片 → 视觉模型描述（server 侧 provider.streamChat）。 */
  modelVision(input: { provider: string; model: string; prompt: string; thinking: boolean; maxTokens?: number; images: Array<{ mediaType: string; data: string }> }): Promise<{ text: string }>;
  /** 读取工作区图片文件（server 侧经 core 沙盒 readFileBase64；path 输入形态）。 */
  readImageFile(sessionId: string, path: string): Promise<{ mediaType: string; data: string }>;
  /** 扩展私有存储（描述缓存与编号表）。 */
  storageRead(path: string): Promise<{ content: string | null }>;
  storageWrite(path: string, content: string): Promise<{ bytes: number }>;
}

export const VISION_DESCRIBE_SYSTEM = "请详细描述这张图片的内容：画面主体、关键细节、文字/代码（如有）、与开发任务相关的信息。使用与提问相同的语言回答。";

/** describe 模式缓存：vision/<图片 sha1>.txt。 */
function cachePath(hash: string): string {
  return `vision/${hash}.txt`;
}

/** toolCall 模式回复缓存：vision/call/<图片 sha1 + request sha1>.txt。 */
function callCachePath(hash: string): string {
  return `vision/call/${hash}.txt`;
}

/** toolCall 模式编号表：vision/ids/<sessionId>.json（{ "<图片 sha1>": N }，N 从 1 递增）。 */
function idsPath(sessionId: string): string {
  return `vision/ids/${sessionId}.json`;
}

function clampMaxTokens(config: Record<string, unknown>): number | undefined {
  const raw = Number(config.maxTokens);
  return Number.isSafeInteger(raw) && raw >= 128 ? Math.min(raw, 4096) : undefined;
}

function describePrompt(config: Record<string, unknown>): string {
  const raw = config.prompt;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : VISION_DESCRIBE_SYSTEM;
}

/** 视觉模型选择器编码值 `provider/model` 拆分。 */
function parseSelection(config: Record<string, unknown>): { provider: string; model: string } {
  const selection = typeof config.model === "string" ? config.model.trim() : "";
  const slash = selection.indexOf("/");
  return {
    provider: slash > 0 ? selection.slice(0, slash).trim() : "",
    model: slash > 0 ? selection.slice(slash + 1).trim() : "",
  };
}

/** 图片内容 sha1（编号表内部键，不对外暴露）。 */
function imageKeyOf(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

/**
 * toolCall 模式会话内图片表：sessionId → Map<编号, { mediaType, data }>。
 * 每轮 context.beforeBuild 用当轮上下文中的图片刷新；编号经 storage 编号表持久化，
 * host 重启后同一会话同一图片编号不变。表仅内存驻留——工具对失效编号返回明确错误，
 * 主模型可改用 path 重试。
 * 内存上限：每会话最多 8 张（旧图淘汰），会话表最多 64 个（最旧淘汰）。
 * /clear 清空上下文时随编号表一并清空（见 bridgeToolCallPlaceholders 的 clear 处理）。
 */
const toolCallImages = new Map<string, Map<number, { mediaType: string; data: string }>>();
const MAX_IMAGES_PER_SESSION = 8;
const MAX_SESSIONS = 64;

/** 各会话已消费的 /clear 边界（ISO 时间）：检出 ledger.cleared.at 变化时清空该会话编号表。 */
const lastClearAt = new Map<string, string>();

function rememberToolCallImage(sessionId: string, number: number, image: { mediaType: string; data: string }): void {
  let table = toolCallImages.get(sessionId);
  if (!table) {
    if (toolCallImages.size >= MAX_SESSIONS && !toolCallImages.has(sessionId)) {
      const oldest = toolCallImages.keys().next().value;
      if (oldest !== undefined) toolCallImages.delete(oldest);
    }
    table = new Map();
    toolCallImages.set(sessionId, table);
  }
  if (table.size >= MAX_IMAGES_PER_SESSION && !table.has(number)) {
    const oldest = table.keys().next().value;
    if (oldest !== undefined) table.delete(oldest);
  }
  table.set(number, image);
}

function toolCallImage(sessionId: string, number: number): { mediaType: string; data: string } | undefined {
  return toolCallImages.get(sessionId)?.get(number);
}

/** describe_image 工具：主模型按需向视觉模型提问（image 编号或工作区 path 二选一）。 */
export const DESCRIBE_IMAGE_SPEC = {
  name: "describe_image",
  description:
    "调用视觉模型查看会话中的图片。image 为图片占位符编号（上下文中的 [图片 #N] 的 N，正整数），path 为工作区图片文件路径（png/jpeg/webp/gif，两者二选一）；request 说明你想了解的内容或对图片的要求。视觉模型会针对 request 回复。",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "integer", minimum: 1, description: "图片占位符编号，如 [图片 #1] 中的 1" },
      path: { type: "string", description: "工作区图片路径（与 image 二选一；受会话沙盒/路径策略约束）" },
      request: { type: "string", description: "你想了解图片的什么内容、或对图片提出的问题/要求" },
    },
    required: ["request"],
  },
  timeoutMs: 60_000,
};

/**
 * describe_image 工具处理器：解析图片（编号/路径）→ 视觉模型按 request 回复（带缓存）。
 * 返回 { content } 或抛错（错误会成为工具结果 isError，回给主模型）。
 */
export async function describeImage(
  api: VisionToolsHostApi,
  input: Record<string, unknown>,
  config: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<{ content: string }> {
  const request = typeof input.request === "string" ? input.request.trim() : "";
  if (!request) throw new Error("describe_image requires a non-empty request string");
  const hasNumber = input.image !== undefined && input.image !== null;
  const imagePath = typeof input.path === "string" ? input.path.trim() : "";
  if (hasNumber === (imagePath !== "")) {
    throw new Error("describe_image requires exactly one of image (placeholder number) or path (workspace file)");
  }

  let image: { mediaType: string; data: string };
  if (hasNumber) {
    const number = Number(input.image);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`invalid image placeholder number: ${String(input.image)}`);
    const entry = sessionId ? toolCallImage(sessionId, number) : undefined;
    if (!entry) {
      throw new Error(`image placeholder #${number} is not available in the current context; try the workspace path instead`);
    }
    image = entry;
  } else {
    image = await api.readImageFile(sessionId ?? "", imagePath);
  }

  const { provider, model } = parseSelection(config);
  if (!provider || !model) throw new Error("vision-tools requires a vision model in its config");
  const cacheEnabled = config.cacheDescriptions !== false;
  const maxTokens = clampMaxTokens(config);
  const thinking = config.thinking !== false;

  const cacheHash = createHash("sha1").update(`${image.data}\n${request}`).digest("hex");
  if (cacheEnabled) {
    try {
      const stored = await api.storageRead(callCachePath(cacheHash));
      if (stored?.content) return { content: stored.content };
    } catch {
      // 缓存读失败按未命中处理
    }
  }
  const completion = await api.modelVision({
    provider,
    model,
    prompt: request,
    thinking,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    images: [{ mediaType: image.mediaType, data: image.data }],
  });
  const text = completion.text.trim();
  if (!text) throw new Error("视觉模型返回为空");
  if (cacheEnabled) void api.storageWrite(callCachePath(cacheHash), text).catch(() => undefined);
  return { content: text };
}

/**
 * context.beforeBuild 钩子：纯文本主模型时把图片替换为视觉模型描述文本（describe）
 * 或编号占位符（toolCall）。返回 {} 表示不干预（透传原始 messages）。
 */
export async function bridgeVisionImages(
  api: VisionToolsHostApi,
  payload: ContextHookPayload,
  config: Record<string, unknown>,
): Promise<ContextHookResult> {
  // 模型选择器编码值：`provider/model`（与设置页模型选择同风格）
  const { provider, model } = parseSelection(config);
  if (!provider || !model) return {};
  const mode = config.mode === "toolCall" ? "toolCall" : "describe";
  const cacheEnabled = config.cacheDescriptions !== false;
  const maxTokens = clampMaxTokens(config);
  const thinking = config.thinking !== false;

  // 收集有 data 的图片块（ref 形态无法直接取图，跳过）
  const imageSpots: Array<{ messageIndex: number; blockIndex: number; mediaType: string; data: string }> = [];
  payload.messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (block.type === "image" && typeof block.data === "string" && block.data !== "") {
        imageSpots.push({ messageIndex, blockIndex, mediaType: block.mediaType, data: block.data });
      }
    });
  });
  if (imageSpots.length === 0) return {};

  // 主模型支持视觉 → 原样透传（图片质量更高，不替换）
  try {
    const session = await api.getSession(payload.sessionId);
    if (session.provider && session.model) {
      const capabilities = await api.getCapabilities(session.model);
      if (capabilities.vision === true) return {};
    }
  } catch {
    // 能力查询失败不阻断：继续按纯文本主模型处理
  }

  if (mode === "toolCall") {
    return bridgeToolCallPlaceholders(api, payload, imageSpots);
  }

  const messages = payload.messages.map((message) => ({ ...message, content: [...message.content] }));
  const used = new Map<string, string>(); // data → 描述（同轮多张相同图只调一次）
  let described = 0;
  let cached = 0;
  let failed = 0;

  for (const spot of imageSpots) {
    const cachedText = used.get(spot.data);
    if (cachedText !== undefined) {
      messages[spot.messageIndex]!.content[spot.blockIndex] = { type: "text", text: cachedText };
      continue;
    }
    const hash = createHash("sha1").update(spot.data).digest("hex");
    let description: string | undefined;
    if (cacheEnabled) {
      try {
        const stored = await api.storageRead(cachePath(hash));
        if (stored?.content) {
          description = stored.content;
          cached += 1;
        }
      } catch {
        // 缓存读失败按未命中处理
      }
    }
    if (description === undefined) {
      try {
        const completion = await api.modelVision({
          provider,
          model,
          prompt: describePrompt(config),
          thinking,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          images: [{ mediaType: spot.mediaType, data: spot.data }],
        });
        description = completion.text.trim() !== "" ? completion.text.trim() : undefined;
        if (description && cacheEnabled) {
          void api.storageWrite(cachePath(hash), description).catch(() => undefined);
        }
        if (description) described += 1;
      } catch {
        failed += 1;
      }
    }
    if (description === undefined) {
      description = "[图片（视觉描述失败，请人工查看）]";
    }
    messages[spot.messageIndex]!.content[spot.blockIndex] = { type: "text", text: description };
    used.set(spot.data, description);
  }

  const metadata: Record<string, unknown> = { extension: "vision-tools", described, cached };
  if (failed > 0) metadata.failed = failed;
  return { messages, metadata };
}

/**
 * toolCall 模式：图片块替换为 [图片 #N] 占位符。N 为会话内稳定编号：
 * 编号表持久化于 storage（vision/ids/<sessionId>.json，键为图片 sha1），
 * 首次出现分配下一个编号并写回，同图跨轮同号、host 重启不变。
 *
 * /clear 清空上下文时旧图编号失效并清空编号表：clear 边界之前的消息（含占位符）
 * 不再进上下文，旧编号既无意义也无引用——hook 检出 ledger.cleared 时（边界变化即视为
 * 新一次 clear）清空该会话的编号表与内存图表，之后重新从 #1 分配。
 */
async function bridgeToolCallPlaceholders(
  api: VisionToolsHostApi,
  payload: ContextHookPayload,
  imageSpots: Array<{ messageIndex: number; blockIndex: number; mediaType: string; data: string }>,
): Promise<ContextHookResult> {
  // /clear 清空上下文：编号表与内存图表随会话上下文一并清空（旧图占位符不再出现，编号失去引用）
  if (payload.ledger.cleared) {
    if (lastClearAt.get(payload.sessionId) !== payload.ledger.cleared.at) {
      lastClearAt.set(payload.sessionId, payload.ledger.cleared.at);
      toolCallImages.delete(payload.sessionId);
      void api.storageWrite(idsPath(payload.sessionId), "{}").catch(() => undefined);
    }
  }

  // 读编号表（缺省/损坏/刚被 clear 清空按空表处理，重新分配）
  let ids: Record<string, number> = {};
  try {
    const stored = await api.storageRead(idsPath(payload.sessionId));
    if (stored?.content) {
      const parsed = JSON.parse(stored.content) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        ids = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "number"),
        ) as Record<string, number>;
      }
    }
  } catch {
    // 编号表损坏按空表重建
  }
  let nextNumber = Object.values(ids).reduce((max, value) => (Number.isSafeInteger(value) && value > max ? value : max), 0) + 1;
  let dirty = false;
  const messages = payload.messages.map((message) => ({ ...message, content: [...message.content] }));
  let replaced = 0;
  const usedInTurn = new Map<string, number>(); // data → 编号（同轮相同图复用编号）

  for (const spot of imageSpots) {
    let number = usedInTurn.get(spot.data);
    if (number === undefined) {
      const key = imageKeyOf(spot.data);
      const existing = ids[key];
      if (typeof existing === "number" && Number.isSafeInteger(existing) && existing >= 1) {
        number = existing;
      } else {
        number = nextNumber;
        nextNumber += 1;
        ids[key] = number;
        dirty = true;
      }
      usedInTurn.set(spot.data, number);
    }
    rememberToolCallImage(payload.sessionId, number, { mediaType: spot.mediaType, data: spot.data });
    messages[spot.messageIndex]!.content[spot.blockIndex] = { type: "text", text: `[图片 #${number}]` };
    replaced += 1;
  }

  if (dirty) {
    void api.storageWrite(idsPath(payload.sessionId), JSON.stringify(ids)).catch(() => undefined);
  }
  return {
    messages,
    metadata: { extension: "vision-tools", mode: "toolCall", placeholders: replaced, images: usedInTurn.size },
  };
}
