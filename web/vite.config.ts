/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Monaco 独立 chunk。这里必须用函数形式（按模块 id 前缀匹配）而不是
 * `{ monaco: ["monaco-editor"] }`：对象形式下 Vite 的 __vitePreload helper（所有懒加载
 * chunk 都要静态 import 它）会被并进同一个 chunk，于是入口与 MarkdownImpl/各面板都静态
 * 引用 monaco chunk，index.html 里出现 4 MB 的 modulepreload——编辑器没打开就先下一遍全量。
 * 函数形式只把 monaco-editor 自己的模块分出去，preload helper 回到 Rollup 的常规共享处理。
 */
function manualChunks(id: string): string | undefined {
  // Vite 的 __vitePreload helper 必须单独成 chunk：它是所有懒加载 chunk 的静态依赖，
  // 若与 monaco 同 chunk，入口就会静态引用 monaco（进而 modulepreload 4 MB）。
  if (id.includes("vite/preload-helper")) return "vite-preload";
  if (!id.includes("/node_modules/monaco-editor/")) return undefined;
  // monaco 的语言模式/基础语法由 monaco 自己按语言动态 import：保持独立懒加载 chunk，
  // 不并进 monaco 主 chunk（否则打开编辑器要一次下全量语言包）。
  if (id.includes("/esm/vs/languages/") || id.includes("/esm/vs/language/") || id.includes("/esm/vs/basic-languages/")) return undefined;
  return "monaco";
}

/**
 * KaTeX 字体裁剪：katex.min.css 的 @font-face src 按 woff2/woff/ttf 顺序列候选，
 * 现代浏览器只取第一个可用的 woff2，ttf/woff 属死重（约 700KB）。构建期不发射这两类字体，
 * woff2 全量保留（59 个字体文件 → 19 个 woff2）。
 */
function stripKatexLegacyFonts(): Plugin {
  return {
    name: "strip-katex-legacy-fonts",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/KaTeX_[\w-]+\.(ttf|woff)$/.test(fileName)) delete bundle[fileName];
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), stripKatexLegacyFonts()],
  build: {
    rollupOptions: {
      output: {
        // Monaco 固定独立 chunk（编辑器懒加载，0.5.0 Phase 1a）；size budget 按名匹配该 chunk
        manualChunks,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3210",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});