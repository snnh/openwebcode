/**
 * Monaco 懒加载器（0.5.0 Phase 1a）：独立 chunk，仅打开编辑器标签/分栏时动态 import，
 * 无编辑器使用不付出体积。加载失败由调用方降级为只读代码视图（Shiki），不阻塞会话。
 * worker 用 vite `?worker` 内联方式（editor.worker 单 worker，不做语言服务）。
 */
import type * as Monaco from "monaco-editor";
// 静态导入 worker 构造器：本模块自身只被懒加载的编辑器引用，不进主入口 chunk。
// 相对路径深导入：monaco-editor 的 exports map 不允许包根深路径（0.5.0 Phase 1a）
import EditorWorker from "../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";

export type MonacoApi = typeof Monaco;

let pending: Promise<MonacoApi> | undefined;

export function loadMonaco(): Promise<MonacoApi> {
  pending ??= (async () => {
    const monaco = await import("monaco-editor");
    (self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
    };
    return monaco;
  })();
  return pending;
}
