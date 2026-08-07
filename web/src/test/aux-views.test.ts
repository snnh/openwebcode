import { beforeEach, describe, expect, it } from "vitest";
import { auxViews, auxViewsStore, diffActions, editorActions } from "../workbench/aux-views";

/** aux-views store 单测：编辑器/diff/代码浮层三者互斥与关闭语义（不渲染组件） */

describe("aux-views store", () => {
  beforeEach(() => {
    auxViews.closeAll();
    editorActions.save = undefined;
    editorActions.focus = undefined;
    diffActions.accept = undefined;
    diffActions.reject = undefined;
    diffActions.focus = undefined;
  });

  it("初始为空；openEditor 打开编辑器分栏", () => {
    expect(auxViewsStore.get()).toEqual({});
    auxViews.openEditor("src/a.ts", { line: 3 });
    expect(auxViewsStore.get().editor).toEqual({ path: "src/a.ts", line: 3 });
  });

  it("三者互斥：openDiff 顶掉 editor，openCodeOverlay 顶掉 diff，openEditor 顶掉 codeOverlay", () => {
    auxViews.openEditor("src/a.ts");
    auxViews.openDiff({ source: "agent-write", path: "src/a.ts", content: "x" });
    expect(auxViewsStore.get().editor).toBeUndefined();
    expect(auxViewsStore.get().diff).toEqual({ source: "agent-write", path: "src/a.ts", content: "x" });

    auxViews.openCodeOverlay("src/b.ts");
    expect(auxViewsStore.get().diff).toBeUndefined();
    expect(auxViewsStore.get().codeOverlay).toBe("src/b.ts");

    auxViews.openEditor("src/c.ts");
    expect(auxViewsStore.get().codeOverlay).toBeUndefined();
    expect(auxViewsStore.get().editor).toEqual({ path: "src/c.ts" });
  });

  it("单项关闭不影响其他状态；closeAll 清空全部（会话切换）", () => {
    auxViews.openEditor("src/a.ts");
    auxViews.closeEditor();
    expect(auxViewsStore.get().editor).toBeUndefined();

    auxViews.openDiff({ source: "scm", path: "src/a.ts", staged: false });
    auxViews.closeAll();
    expect(auxViewsStore.get()).toEqual({ editor: undefined, diff: undefined, codeOverlay: undefined });
  });

  it("动作面是可变对象：EditorPane/DiffPane 挂载时直接在其上注册命令", () => {
    const save = (): void => undefined;
    editorActions.save = save;
    expect(editorActions.save).toBe(save);
  });
});
