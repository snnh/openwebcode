import type { DiffSpec } from "../components/editor/DiffPane";
import { createStore, useStore } from "../app/store";

/**
 * 主区辅助视图状态：编辑器分栏 / 统一 diff 视图 / 只读代码浮层。
 * 三者互斥（同屏最多一个辅助视图）；随需打开、切换会话即关闭，不持久化。
 */

interface AuxViewsState {
  /** 编辑器分栏（Monaco；plan 模式只读） */
  editor?: { path: string; line?: number; column?: number };
  /** 统一 diff 视图（SCM/检查点/工具改动三来源） */
  diff?: DiffSpec;
  /** 只读代码视图浮层的文件路径（Quick Open 打开） */
  codeOverlay?: string;
}

const INITIAL_STATE: AuxViewsState = {};

export const auxViewsStore = createStore<AuxViewsState>(INITIAL_STATE);

export const auxViews = {
  openEditor(path: string, position?: { line?: number; column?: number }): void {
    auxViewsStore.set({
      editor: { path, ...(position?.line !== undefined ? { line: position.line } : {}), ...(position?.column !== undefined ? { column: position.column } : {}) },
      diff: undefined,
      codeOverlay: undefined,
    });
  },
  openDiff(spec: DiffSpec): void {
    auxViewsStore.set({ diff: spec, editor: undefined, codeOverlay: undefined });
  },
  openCodeOverlay(path: string): void {
    auxViewsStore.set({ codeOverlay: path, editor: undefined, diff: undefined });
  },
  closeEditor(): void {
    auxViewsStore.set({ editor: undefined });
  },
  closeDiff(): void {
    auxViewsStore.set({ diff: undefined });
  },
  closeCodeOverlay(): void {
    auxViewsStore.set({ codeOverlay: undefined });
  },
  /** 切换会话：全部辅助视图关闭（布局回归约束） */
  closeAll(): void {
    auxViewsStore.set({ editor: undefined, diff: undefined, codeOverlay: undefined });
  },
};

/** 编辑器命令动作面：mod+s 保存 / 焦点切换（EditorPane 挂载时注册） */
export const editorActions: { save?(): void; focus?(): void } = {};
/** diff 视图命令动作面：接受/拒绝当前 hunk（DiffPane 挂载时注册） */
export const diffActions: { accept?(): void; reject?(): void; focus?(): void } = {};

export function useAuxViews(): AuxViewsState {
  return useStore(auxViewsStore, (state) => state);
}
