/**
 * 测试用 fake Monaco（0.5.0 Phase 1a）：jsdom 无法运行真正的 Monaco，
 * 用最小接口替身驱动 EditorPane 生命周期，并捕获实例供断言（options/值/光标/跳转）。
 */
import type { MonacoApi } from "../../components/editor/monaco-loader";

export interface FakeEditor {
  options: Record<string, unknown>;
  value: string;
  disposed: boolean;
  focused: boolean;
  position?: { lineNumber: number; column: number };
  revealedLine?: number;
  commands: Array<{ keybinding: number; handler: () => void }>;
  getValue(): string;
  setPosition(position: { lineNumber: number; column: number }): void;
  revealLineInCenter(line: number): void;
  focus(): void;
  dispose(): void;
  updateOptions(options: Record<string, unknown>): void;
  addCommand(keybinding: number, handler: () => void): string;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
  onDidChangeCursorPosition(listener: (event: { position: { lineNumber: number } }) => void): { dispose(): void };
  /** 测试驱动：触发内容变化/光标移动监听 */
  __emitContent(): void;
  __emitCursor(line: number): void;
}

export interface FakeDiffEditor {
  options: Record<string, unknown>;
  model?: { original: { value: string }; modified: { value: string } };
  disposed: boolean;
  focused: boolean;
  commands: Array<{ keybinding: number; handler: () => void }>;
  setModel(model: { original: { value: string }; modified: { value: string } }): void;
  focus(): void;
  dispose(): void;
  addCommand(keybinding: number, handler: () => void): string;
}

export function createFakeMonaco(): { monaco: MonacoApi; editors: FakeEditor[]; diffEditors: FakeDiffEditor[] } {
  const editors: FakeEditor[] = [];
  const diffEditors: FakeDiffEditor[] = [];
  const monaco = {
    KeyCode: { Escape: 9 },
    KeyMod: { CtrlCmd: 2048 },
    languages: {
      getLanguages: () => [
        { id: "typescript", extensions: [".ts"] },
        { id: "javascript", extensions: [".js"] },
        { id: "markdown", extensions: [".md"] },
      ],
    },
    editor: {
      setTheme: () => undefined,
      createModel: (value: string) => ({ value, dispose: () => undefined }),
      create: (_element: HTMLElement, options: { model?: { value: string } } & Record<string, unknown>) => {
        let contentListener: (() => void) | undefined;
        let cursorListener: ((event: { position: { lineNumber: number } }) => void) | undefined;
        const editor: FakeEditor = {
          options: { ...options },
          value: options.model?.value ?? "",
          disposed: false,
          focused: false,
          commands: [],
          getValue: () => editor.value,
          setPosition: (position) => { editor.position = position; },
          revealLineInCenter: (line) => { editor.revealedLine = line; },
          focus: () => { editor.focused = true; },
          dispose: () => { editor.disposed = true; },
          updateOptions: (next) => { editor.options = { ...editor.options, ...next }; },
          addCommand: (keybinding, handler) => {
            editor.commands.push({ keybinding, handler });
            return `cmd-${editor.commands.length}`;
          },
          onDidChangeModelContent: (listener) => {
            contentListener = listener;
            return { dispose: () => { contentListener = undefined; } };
          },
          onDidChangeCursorPosition: (listener) => {
            cursorListener = listener;
            return { dispose: () => { cursorListener = undefined; } };
          },
          __emitContent: () => contentListener?.(),
          __emitCursor: (line) => cursorListener?.({ position: { lineNumber: line } }),
        };
        editors.push(editor);
        return editor;
      },
      createDiffEditor: (_element: HTMLElement, options: Record<string, unknown>) => {
        const diffEditor: FakeDiffEditor = {
          options: { ...options },
          disposed: false,
          focused: false,
          commands: [],
          setModel: (model) => { diffEditor.model = model; },
          focus: () => { diffEditor.focused = true; },
          dispose: () => { diffEditor.disposed = true; },
          addCommand: (keybinding, handler) => {
            diffEditor.commands.push({ keybinding, handler });
            return `cmd-${diffEditor.commands.length}`;
          },
        };
        diffEditors.push(diffEditor);
        return diffEditor;
      },
    },
  } as unknown as MonacoApi;
  return { monaco, editors, diffEditors };
}
