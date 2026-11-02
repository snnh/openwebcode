import type * as Monaco from "monaco-editor";

/** 与 tokens-color / 代码高亮色位对齐的 Monaco 主题（亮/暗各一套，定义一次）。 */
let defined = false;

export function applyMonacoTheme(monaco: typeof Monaco, dark: boolean): void {
  if (!defined) {
    monaco.editor.defineTheme("owc-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "8b929c", fontStyle: "italic" },
        { token: "keyword", foreground: "c678dd" },
        { token: "string", foreground: "98c379" },
        { token: "number", foreground: "d19a66" },
        { token: "type", foreground: "e5c07b" },
        { token: "function", foreground: "61afef" },
        { token: "variable", foreground: "abb2bf" },
        { token: "tag", foreground: "e06c75" },
        { token: "attribute.name", foreground: "d19a66" },
        { token: "delimiter", foreground: "abb2bf" },
      ],
      colors: {
        "editor.background": "#141414",
        "editor.foreground": "#e8e8e8",
        "editorLineNumber.foreground": "#4a4a4a",
        "editorLineNumber.activeForeground": "#909090",
        "editor.selectionBackground": "#4a9eff33",
        "editor.inactiveSelectionBackground": "#4a9eff1f",
        "editor.lineHighlightBackground": "#ffffff0a",
        "editorIndentGuide.background1": "#ffffff12",
        "editorIndentGuide.activeBackground1": "#ffffff26",
        "editorCursor.foreground": "#d4d4d4",
        "editorWhitespace.foreground": "#3c3c3c",
        "editorWidget.background": "#252526",
        "editorWidget.border": "#3c3c3c",
        "editorGutter.background": "#141414",
        "editorOverviewRuler.border": "#00000000",
        "scrollbarSlider.background": "#4a4a4a66",
        "scrollbarSlider.hoverBackground": "#5a5a5a99",
      },
    });
    monaco.editor.defineTheme("owc-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "666666", fontStyle: "italic" },
        { token: "keyword", foreground: "a626a4" },
        { token: "string", foreground: "2b7238" },
        { token: "number", foreground: "8a5a00" },
        { token: "type", foreground: "7a5200" },
        { token: "function", foreground: "3060d0" },
        { token: "variable", foreground: "3f3f46" },
        { token: "tag", foreground: "b42332" },
        { token: "attribute.name", foreground: "8a5a00" },
        { token: "delimiter", foreground: "4d4d4d" },
      ],
      colors: {
        "editor.background": "#f2f2f2",
        "editor.foreground": "#1f1f1f",
        "editorLineNumber.foreground": "#a0a0a0",
        "editorLineNumber.activeForeground": "#666666",
        "editor.selectionBackground": "#0b62c433",
        "editor.inactiveSelectionBackground": "#0b62c41f",
        "editor.lineHighlightBackground": "#00000006",
        "editorIndentGuide.background1": "#00000014",
        "editorIndentGuide.activeBackground1": "#00000026",
        "editorCursor.foreground": "#3c3c3c",
        "editorWhitespace.foreground": "#dcdcdc",
        "editorWidget.background": "#ffffff",
        "editorWidget.border": "#dcdcdc",
        "editorGutter.background": "#f2f2f2",
        "editorOverviewRuler.border": "#00000000",
        "scrollbarSlider.background": "#00000026",
        "scrollbarSlider.hoverBackground": "#00000040",
      },
    });
    defined = true;
  }
  monaco.editor.setTheme(dark ? "owc-dark" : "owc-light");
}
