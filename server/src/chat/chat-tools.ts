import { readFile, writeFile } from "node:fs/promises";
import type { ChatMessage, MessageContent } from "../sessions/types.js";
import type { SearchProvider, WebFetchProvider } from "../web-tools.js";
import {
  fetchChatImage,
  mediaTypeForFile,
  resolveSessionPath,
  saveGeneratedImage,
  IMAGE_ASPECT_RATIOS,
  type ImageAspectRatio,
  type VisionReasoning,
} from "./chat-media.js";
import type { ChatPythonEnv } from "./chat-python-env.js";
import { executePython, type ChatPythonCoreBridge } from "./chat-python-runner.js";
import type { ChatToolCategory } from "./chat-types.js";

/** 聊天工具执行上下文：由 ChatRunner 装配，处理器按分类取用所需能力。 */
export interface ChatToolContext {
  searchProvider: SearchProvider | undefined;
  webFetchProvider: WebFetchProvider | undefined;
  /** media 适配器现读（chat.json imageGenModel/visionModel 热生效）：handler 调用点现构建，未配置返回 undefined。 */
  getImageGenProvider: () => Promise<ImageGenProvider | undefined>;
  getVisionProvider: () => Promise<VisionProvider | undefined>;
  /** 会话消息回溯（vision 省略 source 时取最近一张图片块）；runner 传入前已把 ref 块内联为 data。 */
  messages?: ChatMessage[];
  /** fetch 注入点（测试 mock；缺省 globalThis.fetch，跟随全局代理 dispatcher）。 */
  fetchImpl?: typeof fetch;
  pythonEnv: ChatPythonEnv;
  sessionDir: string;
  signal: AbortSignal;
  /** 会话 meta.cwd：已设置且为存在目录时作为 python 子进程 cwd。 */
  cwd?: string | undefined;
  /** core 桥接（CoreRouter）：Windows 上 python 经 job.* 在 Job Object 内运行。 */
  core?: ChatPythonCoreBridge | undefined;
  /** chat 会话 id（core 路由拼 "chat-python-<id>" 用）。 */
  sessionId?: string | undefined;
  /** python 环境准备状态上报（ChatRunner 接进 SSE）。 */
  onPythonStatus?: ((status: "preparing" | "ready" | "error", detail?: string) => void) | undefined;
}

/** 图像生成能力（外部 API；未配置时 image_gen 返回错误文本）。 */
export interface ImageGenProvider {
  name: string;
  generate(prompt: string, options?: { aspectRatio?: ImageAspectRatio; signal?: AbortSignal }): Promise<{ data: string; mediaType: string }>;
}

/** 图像理解能力（外部 API；未配置时 vision 返回错误文本）。 */
export interface VisionProvider {
  name: string;
  analyze(image: { data: string; mediaType: string }, prompt: string, options?: { reasoning?: VisionReasoning; signal?: AbortSignal }): Promise<string>;
}

interface ChatToolDef {
  name: string;
  description: string;
  inputSchema: object;
  category: ChatToolCategory;
  /** sandbox 类工具需会话开启 sandboxEnabled 才允许执行。 */
  requiresSandbox: boolean;
  handler: (input: Record<string, unknown>, ctx: ChatToolContext) => Promise<MessageContent[]>;
}

function text(value: string): MessageContent[] {
  return [{ type: "text", text: value }];
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing or invalid parameter: ${key}`);
  return value;
}

/** aspectRatio 枚举校验（缺省 1:1；非法值抛错，由 runner 包成工具错误文本）。 */
function parseAspectRatio(value: unknown): ImageAspectRatio {
  if (value === undefined) return "1:1";
  if (typeof value === "string" && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value)) return value as ImageAspectRatio;
  throw new Error(`Invalid aspectRatio: ${String(value)} (expected one of ${IMAGE_ASPECT_RATIOS.join(", ")})`);
}

/** reasoning 枚举校验（缺省 off）。 */
function parseVisionReasoning(value: unknown): VisionReasoning {
  if (value === undefined) return "off";
  if (value === "off" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`Invalid reasoning: ${String(value)} (expected off, low, medium or high)`);
}

/**
 * vision 图源解析（多形态）：
 * - 省略：回溯会话最近一张图片块（用户上传或 image_gen 产出）
 * - http(s)://：经 server 出网抓取（SSRF 块表 + 10MB 上限）
 * - 其他：sessionDir 相对路径读文件（与 read_file 同级防护）
 */
async function resolveVisionSource(source: unknown, ctx: ChatToolContext): Promise<{ data: string; mediaType: string }> {
  if (source === undefined) {
    for (const message of [...(ctx.messages ?? [])].reverse()) {
      for (const block of [...message.content].reverse()) {
        if (block.type !== "image") continue;
        if (block.data) return { data: block.data, mediaType: block.mediaType };
        if (block.ref) {
          const resolved = resolveSessionPath(ctx.sessionDir, block.ref);
          return { data: (await readFile(resolved)).toString("base64"), mediaType: block.mediaType };
        }
      }
    }
    throw new Error("No image found in the conversation; provide source explicitly");
  }
  if (typeof source !== "string" || !source) throw new Error("Missing or invalid parameter: source");
  if (/^https?:\/\//i.test(source)) {
    return fetchChatImage(source, { signal: ctx.signal, ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) });
  }
  const resolved = resolveSessionPath(ctx.sessionDir, source);
  const mediaType = mediaTypeForFile(resolved);
  if (!mediaType) throw new Error(`Unsupported image type: ${source}`);
  return { data: (await readFile(resolved)).toString("base64"), mediaType };
}

/**
 * 安全数学表达式求值：手写递归下降解析器，不经过 eval/Function。
 * 支持 + - * / % ^（右结合）、括号、一元负号、
 * 函数 sqrt/abs/log(10 底)/ln/sin/cos/tan 与常量 pi/e。
 */
export function calculateExpression(source: string): number {
  const parser = new ExpressionParser(source);
  const value = parser.parseExpression();
  parser.expectEnd();
  if (!Number.isFinite(value)) throw new Error("Result is not finite");
  return value;
}

class ExpressionParser {
  private pos = 0;

  private static readonly FUNCTIONS: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    log: Math.log10,
    ln: Math.log,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
  };

  private static readonly CONSTANTS: Record<string, number> = {
    pi: Math.PI,
    e: Math.E,
  };

  constructor(private readonly source: string) {}

  private skipWhitespace(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos]!)) this.pos++;
  }

  private peek(): string | undefined {
    this.skipWhitespace();
    return this.source[this.pos];
  }

  parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      const op = this.peek();
      if (op === "+") {
        this.pos++;
        value += this.parseTerm();
      } else if (op === "-") {
        this.pos++;
        value -= this.parseTerm();
      } else {
        return value;
      }
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (true) {
      const op = this.peek();
      if (op === "*") {
        this.pos++;
        value *= this.parseFactor();
      } else if (op === "/") {
        this.pos++;
        value /= this.parseFactor();
      } else if (op === "%") {
        this.pos++;
        value %= this.parseFactor();
      } else {
        return value;
      }
    }
  }

  private parseFactor(): number {
    const base = this.parseUnary();
    if (this.peek() === "^") {
      this.pos++;
      // 右结合：2^3^2 = 2^(3^2)
      return base ** this.parseFactor();
    }
    return base;
  }

  private parseUnary(): number {
    if (this.peek() === "-") {
      this.pos++;
      return -this.parseUnary();
    }
    if (this.peek() === "+") {
      this.pos++;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const ch = this.peek();
    if (ch === undefined) throw new Error("Unexpected end of expression");
    if (ch === "(") {
      this.pos++;
      const value = this.parseExpression();
      if (this.peek() !== ")") throw new Error("Missing closing parenthesis");
      this.pos++;
      return value;
    }
    if (/[0-9.]/.test(ch)) return this.parseNumber();
    if (/[a-zA-Z_]/.test(ch)) return this.parseIdentifier();
    throw new Error(`Unexpected character: ${ch}`);
  }

  private parseNumber(): number {
    const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.pos));
    if (!match) throw new Error(`Invalid number at position ${this.pos}`);
    this.pos += match[0].length;
    return Number.parseFloat(match[0]);
  }

  private parseIdentifier(): number {
    const match = /^[a-zA-Z_]\w*/.exec(this.source.slice(this.pos))!;
    const name = match[0];
    this.pos += name.length;
    if (this.peek() === "(") {
      const fn = ExpressionParser.FUNCTIONS[name];
      if (!fn) throw new Error(`Unknown function: ${name}`);
      this.pos++;
      const arg = this.parseExpression();
      if (this.peek() !== ")") throw new Error("Missing closing parenthesis");
      this.pos++;
      return fn(arg);
    }
    const constant = ExpressionParser.CONSTANTS[name];
    if (constant !== undefined) return constant;
    throw new Error(`Unknown identifier: ${name}`);
  }

  expectEnd(): void {
    if (this.peek() !== undefined) throw new Error(`Unexpected trailing input at position ${this.pos}`);
  }
}

/** 聊天模式内置工具清单（10 个，按分类组织）。 */
export function chatTools(): ChatToolDef[] {
  return [
    // ---- utility：无沙盒无网络 ----
    {
      name: "time",
      description: "Return the current date and time in ISO 8601 format.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      category: "utility",
      requiresSandbox: false,
      handler: async () => text(new Date().toISOString()),
    },
    {
      name: "calculate",
      description: "Evaluate a math expression. Supports + - * / % ^, parentheses, sqrt/abs/log/ln/sin/cos/tan, pi and e.",
      inputSchema: {
        type: "object",
        properties: { expression: { type: "string", description: "Math expression to evaluate" } },
        required: ["expression"],
        additionalProperties: false,
      },
      category: "utility",
      requiresSandbox: false,
      handler: async (input) => text(String(calculateExpression(requireString(input, "expression")))),
    },
    // ---- web：需要网络 ----
    {
      name: "web_search",
      description: "Search the web and return the top results (title, url, snippet).",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
        additionalProperties: false,
      },
      category: "web",
      requiresSandbox: false,
      handler: async (input, ctx) => {
        if (!ctx.searchProvider) return text("Error: web search is not configured");
        const results = await ctx.searchProvider.search(requireString(input, "query"), 5, { signal: ctx.signal });
        return text(JSON.stringify(results, null, 2));
      },
    },
    {
      name: "web_fetch",
      description: "Fetch a web page and return its text content.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "URL to fetch" } },
        required: ["url"],
        additionalProperties: false,
      },
      category: "web",
      requiresSandbox: false,
      handler: async (input, ctx) => {
        if (!ctx.webFetchProvider) return text("Error: web fetch is not configured");
        const result = await ctx.webFetchProvider.fetchUrl(requireString(input, "url"), { signal: ctx.signal });
        return text(result.text);
      },
    },
    // ---- media：需要外部 API ----
    {
      name: "image_gen",
      description: "Generate an image from a text prompt.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image description" },
          aspectRatio: { type: "string", enum: [...IMAGE_ASPECT_RATIOS], description: "Aspect ratio (default 1:1)" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      category: "media",
      requiresSandbox: false,
      handler: async (input, ctx) => {
        const provider = await ctx.getImageGenProvider();
        if (!provider) return text("Error: image generation is not configured");
        const aspectRatio = parseAspectRatio(input.aspectRatio);
        const image = await provider.generate(requireString(input, "prompt"), { aspectRatio, signal: ctx.signal });
        // 生成图统一落盘 generated/：块内联返回（当轮 SSE 可见）+ ref 随工具消息持久化（供 vision 回溯与刷新后展示）
        const ref = await saveGeneratedImage(ctx.sessionDir, image);
        return [{ type: "image", data: image.data, mediaType: image.mediaType, ref }];
      },
    },
    {
      name: "vision",
      description: "Analyze an image and answer a question about it. Source may be omitted (uses the most recent image in the conversation), a session-relative path (e.g. uploads/...), or an http(s) URL.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Image source: session-relative path or http(s) URL; omit to use the latest image in the conversation" },
          prompt: { type: "string", description: "Question or instruction about the image" },
          reasoning: { type: "string", enum: ["off", "low", "medium", "high"], description: "Reasoning effort for the vision model (default off)" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      category: "media",
      requiresSandbox: false,
      handler: async (input, ctx) => {
        const provider = await ctx.getVisionProvider();
        if (!provider) return text("Error: vision is not configured");
        const prompt = requireString(input, "prompt");
        const reasoning = parseVisionReasoning(input.reasoning);
        const image = await resolveVisionSource(input.source, ctx);
        return text(await provider.analyze(image, prompt, { reasoning, signal: ctx.signal }));
      },
    },
    // ---- sandbox：需会话开启 sandboxEnabled ----
    {
      name: "python",
      description: "Execute Python code in an isolated environment. Generated images (matplotlib savefig) are returned inline.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string", description: "Python code to execute" } },
        required: ["code"],
        additionalProperties: false,
      },
      category: "sandbox",
      requiresSandbox: true,
      handler: async (input, ctx) => {
        const code = requireString(input, "code");
        ctx.onPythonStatus?.("preparing");
        try {
          await ctx.pythonEnv.ensure();
        } catch (error) {
          ctx.onPythonStatus?.("error", String(error instanceof Error ? error.message : error).slice(0, 200));
          throw error;
        }
        ctx.onPythonStatus?.("ready");
        const result = await executePython(ctx.pythonEnv, ctx.sessionDir, code, ctx.signal, { cwd: ctx.cwd, core: ctx.core, sessionId: ctx.sessionId });
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
        parts.push(`[exit_code] ${result.exitCode}`);
        parts.push(`[isolated] ${result.isolated}`);
        if (!result.isolated && result.containment === "jobobject") {
          parts.push("[containment] jobobject (process-tree limits only; no network/FS isolation)");
        } else if (result.containment === "none") {
          parts.push("[containment] none (no OS isolation)");
        }
        if (result.sandboxCapability) parts.push(`[sandbox] ${result.sandboxCapability}`);
        const content: MessageContent[] = [{ type: "text", text: parts.join("\n") }];
        for (const image of result.images ?? []) {
          content.push({ type: "image", data: image.data, mediaType: image.mediaType });
        }
        return content;
      },
    },
    {
      name: "read_file",
      description: "Read a text file from the session workspace directory.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "File path relative to the session directory" } },
        required: ["path"],
        additionalProperties: false,
      },
      category: "sandbox",
      requiresSandbox: true,
      handler: async (input, ctx) => {
        const resolved = resolveSessionPath(ctx.sessionDir, requireString(input, "path"));
        return text(await readFile(resolved, "utf8"));
      },
    },
    {
      name: "write_file",
      description: "Write text content to a file in the session workspace directory.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the session directory" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      category: "sandbox",
      requiresSandbox: true,
      handler: async (input, ctx) => {
        const resolved = resolveSessionPath(ctx.sessionDir, requireString(input, "path"));
        const content = requireString(input, "content");
        await writeFile(resolved, content, "utf8");
        return text(`Wrote ${content.length} characters to ${input.path as string}`);
      },
    },
    {
      name: "show",
      description: "Display text or an image directly in the chat UI.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Text content, or base64 image data when contentType is an image/* type" },
          contentType: { type: "string", description: "MIME type of the content (default text/plain)" },
        },
        required: ["content"],
        additionalProperties: false,
      },
      category: "sandbox",
      requiresSandbox: true,
      handler: async (input) => {
        const content = requireString(input, "content");
        const contentType = typeof input.contentType === "string" ? input.contentType : "text/plain";
        if (contentType.startsWith("image/")) {
          return [{ type: "image", data: content, mediaType: contentType }];
        }
        return text(content);
      },
    },
  ];
}
