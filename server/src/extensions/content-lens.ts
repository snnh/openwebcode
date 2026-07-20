import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Provider2Client } from "../provider2.js";
import type { SessionStore } from "../sessions/session-store.js";

interface CachedLensResult { key: string; text: string; createdAt: string }

export class ContentLensService {
  constructor(private readonly sessions: SessionStore, private readonly provider2: Provider2Client) {}

  async translate(sessionId: string, messageId: string, targetLanguage: string, glossary: Record<string, string> = {}): Promise<{ text: string; cached: boolean }> {
    if (!this.provider2.configured) throw new Error("provider2 未配置，内容透镜无法翻译");
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const message = session.messages.find((item) => item.id === messageId);
    if (!message) throw new Error("Message not found");
    const source = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
    if (!source.trim()) throw new Error("Message has no translatable text");
    const key = createHash("sha256").update(JSON.stringify({ source, targetLanguage, glossary })).digest("hex");
    const messageKey = createHash("sha256").update(messageId).digest("hex").slice(0, 24);
    const file = path.join(this.sessions.contextRoot(sessionId), "translations", `${messageKey}-${safeName(targetLanguage)}.json`);
    const cached = await readCache(file);
    if (cached?.key === key) return { text: cached.text, cached: true };
    const completion = await this.provider2.complete({
      system: "你是代码助手的翻译器。保持 Markdown 结构、段落和列表逐块对齐；代码块及行内代码原样保留；只输出译文。",
      prompt: `目标语言：${targetLanguage}\n术语表：${JSON.stringify(glossary)}\n\n原文：\n${source}`,
      maxTokens: 4096,
    });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ key, text: completion.text, createdAt: new Date().toISOString() } satisfies CachedLensResult, null, 2)}\n`, "utf8");
    return { text: completion.text, cached: false };
  }

  async explain(sessionId: string, text: string, targetLanguage: string): Promise<{ text: string }> {
    if (!this.provider2.configured) throw new Error("provider2 未配置，内容透镜无法解析");
    if (!(await this.sessions.get(sessionId))) throw new Error("Session not found");
    const selected = text.trim();
    if (!selected || selected.length > 200) throw new Error("选中文本长度必须为 1–200 字符");
    const completion = await this.provider2.complete({
      system: "你是代码与技术术语解释器。用 2–3 句简洁说明选中内容的含义和在编程上下文中的作用；不确定时明确说明。只输出解释。",
      prompt: `回答语言：${targetLanguage}\n选中内容：${selected}`,
      maxTokens: 512,
    });
    return { text: completion.text };
  }
}

async function readCache(file: string): Promise<CachedLensResult | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<CachedLensResult>;
    return typeof value.key === "string" && typeof value.text === "string" && typeof value.createdAt === "string"
      ? value as CachedLensResult
      : undefined;
  } catch { return undefined; }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32) || "target";
}
