// 高亮器按需异步加载（独立 chunk），首个代码块出现时才下载 shiki 语法
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

let highlighterPromise: Promise<Awaited<ReturnType<typeof load>>> | undefined;

async function load() {
  const { createOwcHighlighter } = await import("./shiki-highlighter");
  return createOwcHighlighter();
}

function getHighlighter(): Promise<Awaited<ReturnType<typeof load>>> {
  highlighterPromise ??= load();
  return highlighterPromise;
}

/** 返回双主题高亮 HTML（CSS 变量随 data-theme 切换），语言不支持或失败时返回 undefined */
export async function highlightCode(code: string, lang?: string): Promise<string | undefined> {
  const normalized = (lang ?? "").toLowerCase();
  const target = SUPPORTED.has(normalized) ? normalized : LANG_ALIASES[normalized];
  if (!target) return undefined;
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, {
      lang: target,
      themes: { light: "github-light", dark: "github-dark" },
    });
  } catch {
    return undefined;
  }
}
