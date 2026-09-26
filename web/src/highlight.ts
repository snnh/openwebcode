import type { HighlighterCore } from "shiki/core";
import { EXT_LANGS } from "./lib/file-langs";

// 高亮器按需异步加载（独立 chunk），首个代码块出现时才下载 shiki 核心与主题
const SUPPORTED = new Set([
  "typescript", "javascript", "tsx", "jsx", "json", "bash",
  "python", "css", "html", "diff", "markdown", "yaml",
]);

// 代码块语言别名：扩展名映射（lib/file-langs 单一来源）+ 仅围栏语言出现的别名
const LANG_ALIASES: Record<string, string> = { ...EXT_LANGS, shell: "bash", zsh: "bash" };

// 语言 grammar 静态映射表：动态 import 必须是字面量路径，vite 才能正确分包。
// 每种语言独立 chunk，首次遇到该语言代码块时才下载。
const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  bash: () => import("shiki/dist/langs/bash.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
};

/**
 * 单次高亮的字符上限：shiki 在主线程同步执行，实测约 5ms/KB（55KB ≈ 265ms），
 * 超过该阈值只渲染纯文本（内容仍可复制、可在编辑器中打开），避免打开预览/大工具卡时卡住界面。
 */
export const HIGHLIGHT_MAX_CHARS = 60_000;

/** 内容是否值得高亮（超阈值返回 false，由调用方降级为纯文本并提示）。 */
export function shouldHighlight(code: string): boolean {
  return code.length <= HIGHLIGHT_MAX_CHARS;
}

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterPromise: Promise<Highlighter> | undefined;
const langPromises = new Map<string, Promise<void>>();

async function createHighlighter() {
  const { createOwcHighlighter } = await import("./shiki-highlighter");
  return createOwcHighlighter();
}

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter();
  return highlighterPromise;
}

/** 按需加载语言 grammar 并缓存；并发调用共享同一 Promise */
function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<void> {
  let pending = langPromises.get(lang);
  if (!pending) {
    const loader = LANG_LOADERS[lang];
    pending = loader().then((mod) =>
      highlighter.loadLanguage(mod.default as Parameters<HighlighterCore["loadLanguage"]>[0]),
    );
    langPromises.set(lang, pending);
  }
  return pending;
}

// 高亮结果缓存：同一代码块（语言+内容）只高亮一次。流式代码块内容变化时 key 随之变化，
// 天然只重算正在更新的块；已完成块重新挂载（虚拟化窗口滚动回来）直接命中缓存。
// 双重上限：条数防 key 无限增长，累计体积防大代码块把内存吃掉（256 条 × 数十 KB ≈ 数十 MB）。
const HIGHLIGHT_CACHE_LIMIT = 256;
/**
 * 缓存累计体积上限（字节口径）：按缓存值的 UTF-16 码元数 × 2 估算——JS 字符串超过一定长度后
 * V8 用 two-byte 表示（高亮 HTML 几乎全为 ASCII，按 2 计是保守高估），string[] 逐行累加。
 * 8 MiB 约等于 400 个 20 KB 的高亮块，远大于虚拟化列表同时可见的块数。
 */
const HIGHLIGHT_CACHE_BYTES_LIMIT = 8 * 1024 * 1024;

interface CacheEntry {
  promise: Promise<string | string[] | undefined>;
  /** 结果落地后的估算字节数；Promise 未落地时按 0 计（体积逐出因此晚一个微任务生效） */
  bytes: number;
}

// 缓存值：整文件高亮 HTML（string）或按行高亮片段（string[]），由 cacheKey 前缀区分
const highlightCache = new Map<string, CacheEntry>();
let highlightCacheBytes = 0;

/** 估算缓存值的字节占用：string 按 length×2，string[] 逐行累加，undefined（高亮失败）记 0 */
function estimateBytes(value: string | string[] | undefined): number {
  if (typeof value === "string") return value.length * 2;
  if (Array.isArray(value)) return value.reduce((sum, line) => sum + line.length * 2, 0);
  return 0;
}

/** LRU 逐出：条数或累计体积超限时，从最旧（最久未用）条目开始删 */
function evictOverflow(): void {
  while (highlightCache.size > HIGHLIGHT_CACHE_LIMIT || highlightCacheBytes > HIGHLIGHT_CACHE_BYTES_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest === undefined) return;
    const entry = highlightCache.get(oldest);
    highlightCache.delete(oldest);
    if (entry) highlightCacheBytes -= entry.bytes;
  }
}

/** 命中即移到最新位：Map 保持插入序，delete + set 即一次 LRU touch */
function touchCache(key: string, entry: CacheEntry): void {
  highlightCache.delete(key);
  highlightCache.set(key, entry);
}

/** 写入缓存并按双重上限逐出；结果落地后才知道真实体积，故再补一次体积维度的逐出 */
function putCache<T extends string | string[] | undefined>(key: string, promise: Promise<T>): Promise<T> {
  const entry: CacheEntry = { promise, bytes: 0 };
  highlightCache.set(key, entry);
  evictOverflow();
  void promise
    .then((value) => {
      // 已被逐出（或同 key 已被新条目替换）则丢弃这次统计，避免字节计数错账
      if (highlightCache.get(key) !== entry) return;
      entry.bytes = estimateBytes(value);
      highlightCacheBytes += entry.bytes;
      evictOverflow();
    })
    .catch(() => undefined);
  return promise;
}

/** 简单的字符串 hash（FNV-1a 32bit），配合长度把碰撞概率降到可忽略 */
function hashCode(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 返回双主题高亮 HTML（CSS 变量随 data-theme 切换），语言不支持或失败时返回 undefined */
export async function highlightCode(code: string, lang?: string): Promise<string | undefined> {
  const normalized = (lang ?? "").toLowerCase();
  const target = SUPPORTED.has(normalized) ? normalized : LANG_ALIASES[normalized];
  if (!target) return undefined;
  const cacheKey = `${target}:${code.length}:${hashCode(code)}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    touchCache(cacheKey, cached);
    return cached.promise as Promise<string | undefined>;
  }
  const promise = (async (): Promise<string | undefined> => {
    try {
      const highlighter = await getHighlighter();
      await ensureLanguage(highlighter, target);
      return highlighter.codeToHtml(code, {
        lang: target,
        themes: { light: "github-light", dark: "github-dark" },
      });
    } catch {
      return undefined;
    }
  })();
  return putCache(cacheKey, promise);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 按行返回高亮 HTML 片段（每行一个字符串，供只读代码视图逐行渲染行号）。
 * 复用同一高亮器与语言动态加载；语言不支持或失败时返回 undefined，调用方回退纯文本。
 */
export async function highlightLines(code: string, lang?: string): Promise<string[] | undefined> {
  const normalized = (lang ?? "").toLowerCase();
  const target = SUPPORTED.has(normalized) ? normalized : LANG_ALIASES[normalized];
  if (!target) return undefined;
  const cacheKey = `lines:${target}:${code.length}:${hashCode(code)}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    touchCache(cacheKey, cached);
    return cached.promise as Promise<string[] | undefined>;
  }
  const promise = (async (): Promise<string[] | undefined> => {
    try {
      const highlighter = await getHighlighter();
      await ensureLanguage(highlighter, target);
      const { tokens } = highlighter.codeToTokens(code, {
        lang: target,
        themes: { light: "github-light", dark: "github-dark" },
      });
      return tokens.map((line) =>
        line.map((token) => {
          // 双主题时 htmlStyle 为对象（color 为亮色值，--shiki-dark 为暗色变量），序列化为内联样式
          const raw = token.htmlStyle;
          const style = typeof raw === "string"
            ? raw
            : raw && typeof raw === "object"
              ? Object.entries(raw).map(([key, value]) => `${key}:${value}`).join(";")
              : "";
          return style ? `<span style="${escapeHtml(style)}">${escapeHtml(token.content)}</span>` : escapeHtml(token.content);
        }).join(""));
    } catch {
      return undefined;
    }
  })();
  return putCache(cacheKey, promise);
}
