import type { HighlighterCore } from "shiki/core";

// 高亮器按需异步加载（独立 chunk），首个代码块出现时才下载 shiki 核心与主题
const SUPPORTED = new Set([
  "typescript", "javascript", "tsx", "jsx", "json", "bash",
  "python", "css", "html", "diff", "markdown", "yaml",
]);

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
};

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
const HIGHLIGHT_CACHE_LIMIT = 256;
const highlightCache = new Map<string, Promise<string | undefined>>();

/** 简单的字符串 hash（FNV-1a 32bit），配合长度把碰撞概率降到可忽略 */
function hashCode(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 清空高亮结果缓存（测试用；运行期缓存有界无需清理） */
export function clearHighlightCache(): void {
  highlightCache.clear();
}

/** 返回双主题高亮 HTML（CSS 变量随 data-theme 切换），语言不支持或失败时返回 undefined */
export async function highlightCode(code: string, lang?: string): Promise<string | undefined> {
  const normalized = (lang ?? "").toLowerCase();
  const target = SUPPORTED.has(normalized) ? normalized : LANG_ALIASES[normalized];
  if (!target) return undefined;
  const cacheKey = `${target}:${code.length}:${hashCode(code)}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;
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
  highlightCache.set(cacheKey, promise);
  // LRU：超限时淘汰最久未用的条目
  if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  return promise;
}
