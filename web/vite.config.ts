/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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
        manualChunks: { monaco: ["monaco-editor"] },
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