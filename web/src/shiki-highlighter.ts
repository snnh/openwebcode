import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import themeDark from "shiki/dist/themes/github-dark.mjs";
import themeLight from "shiki/dist/themes/github-light.mjs";

// 独立 chunk：由 highlight.ts 在首个代码块出现时动态加载。
// 只含核心与主题；具体语言 grammar 由 highlight.ts 通过 loadLanguage 按需加载。
export function createOwcHighlighter(): ReturnType<typeof createHighlighterCore> {
  return createHighlighterCore({
    themes: [themeLight, themeDark],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
}
