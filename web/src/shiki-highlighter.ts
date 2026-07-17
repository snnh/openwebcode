import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import langBash from "shiki/dist/langs/bash.mjs";
import langCss from "shiki/dist/langs/css.mjs";
import langDiff from "shiki/dist/langs/diff.mjs";
import langHtml from "shiki/dist/langs/html.mjs";
import langJavascript from "shiki/dist/langs/javascript.mjs";
import langJson from "shiki/dist/langs/json.mjs";
import langJsx from "shiki/dist/langs/jsx.mjs";
import langMarkdown from "shiki/dist/langs/markdown.mjs";
import langPython from "shiki/dist/langs/python.mjs";
import langTsx from "shiki/dist/langs/tsx.mjs";
import langTypescript from "shiki/dist/langs/typescript.mjs";
import langYaml from "shiki/dist/langs/yaml.mjs";
import themeDark from "shiki/dist/themes/github-dark.mjs";
import themeLight from "shiki/dist/themes/github-light.mjs";

// 独立 chunk：由 highlight.ts 在首个代码块出现时动态加载
export function createOwcHighlighter(): ReturnType<typeof createHighlighterCore> {
  return createHighlighterCore({
    themes: [themeLight, themeDark],
    langs: [
      langTypescript, langJavascript, langTsx, langJsx, langJson, langBash,
      langPython, langCss, langHtml, langDiff, langMarkdown, langYaml,
    ],
    engine: createJavaScriptRegexEngine(),
  });
}
