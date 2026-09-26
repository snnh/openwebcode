import { afterEach, describe, expect, it } from "vitest";
import { parsePath } from "../app/router";
import { readChatModeEnabled } from "../app/chat-mode-sync";
import { ui, uiStore } from "../app/ui-store";
import type { SettingsField, SettingsView } from "../lib/contracts";
const booleanField = (key: string, value: boolean): SettingsField => ({ key, label: key, type: "boolean", value, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false });
const settingsView = (chatModeEnabled?: boolean): SettingsView => ({ groups: [{ id: "general", label: "通用", fields: chatModeEnabled === undefined ? [] : [booleanField("chatModeEnabled", chatModeEnabled)] }] });
describe("parsePath", () => {
  it("识别 chat/workbench/share 路由，未知路径回落 chat", () => {
    const cases: Array<[string, unknown]> = [
      ["/", { name: "chat" }], ["/workbench", { name: "workbench" }],
      ["/share/abc12345/hello-world", { name: "share", shareId: "abc12345", slug: "hello-world" }],
      ["/share/abc12345/hello-world/extra", { name: "chat" }], ["/no-such-page", { name: "chat" }],
    ];
    for (const [input, expected] of cases) expect(parsePath(input)).toEqual(expected);
  });
});
describe("chatModeEnabled 同步", () => {
  afterEach(() => ui.setChatModeEnabled(false));
  it("数据未就绪/缺字段返回 undefined 且不改本地；到达后同步，非法值按关闭", () => {
    ui.setChatModeEnabled(true);
    expect(readChatModeEnabled(undefined)).toBeUndefined(); expect(readChatModeEnabled(settingsView())).toBeUndefined();
    expect(uiStore.get().chatModeEnabled).toBe(true);
    ui.setChatModeEnabled(readChatModeEnabled(settingsView(true)) ?? false); expect(uiStore.get().chatModeEnabled).toBe(true);
    ui.setChatModeEnabled(readChatModeEnabled(settingsView(false)) ?? true); expect(uiStore.get().chatModeEnabled).toBe(false);
    const invalid: SettingsView = { groups: [{ id: "general", label: "通用", fields: [{ ...booleanField("chatModeEnabled", false), value: "yes" }] }] };
    expect(readChatModeEnabled(invalid)).toBe(false);
  });
});
