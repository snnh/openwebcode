import { vi } from "vitest";
import type { CommandActions } from "../../commands/builtin";

/** CommandActions 全量 vi.fn() 桩，支持单项 override（如 findInConversation 走真实 window 事件桥接）。 */
export function stubActions(overrides: Partial<CommandActions> = {}): CommandActions {
  return {
    showCommands: vi.fn(), quickOpen: vi.fn(), toggleSidebar: vi.fn(), toggleBottomPanel: vi.fn(),
    showView: vi.fn(), openSettings: vi.fn(), newSession: vi.fn(), importSession: vi.fn(),
    deleteCurrentSession: vi.fn(), sendDraft: vi.fn(), abortRun: vi.fn(), toggleTheme: vi.fn(),
    focusComposer: vi.fn(), nextSession: vi.fn(), previousSession: vi.fn(),
    showKeyboardShortcuts: vi.fn(), cycleZone: vi.fn(), showNotifications: vi.fn(),
    saveEditorFile: vi.fn(), toggleEditorSplit: vi.fn(),
    diffAcceptHunk: vi.fn(), diffRejectHunk: vi.fn(),
    findInConversation: vi.fn(),
    ...overrides,
  };
}
