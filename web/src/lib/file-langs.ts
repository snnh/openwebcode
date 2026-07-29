/** 文件扩展名 → shiki 语言 ID 的单一来源；支持集之外自动回退纯文本（见 highlight.ts）。 */
export const EXT_LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", html: "html", htm: "html", md: "markdown", markdown: "markdown",
  py: "python", sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", diff: "diff", patch: "diff",
};

/** 从文件路径推断 shiki 语言 ID；未知扩展名原样返回，由 highlight.ts 判定不支持时回退纯文本。 */
export function langFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext || ext === path) return undefined;
  return EXT_LANGS[ext] ?? ext;
}
