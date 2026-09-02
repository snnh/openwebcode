import { afterEach, describe, expect, it } from "vitest";
import { parsePath } from "../app/router";
import { readChatModeEnabled } from "../app/chat-mode-sync";
import { ui, uiStore } from "../app/ui-store";
import type { SettingsField, SettingsView } from "../lib/contracts";

function booleanField(key: string, value: boolean): SettingsField {
  return {
    key,
    label: key,
    type: "boolean",
    value,
    hasValue: true,
    source: "default",
    editable: true,
    restartRequired: false,
    nullable: false,
  };
}

function settingsView(chatModeEnabled?: boolean): SettingsView {
  return {
    groups: [
      { id: "general", label: "通用", fields: chatModeEnabled === undefined ? [] : [booleanField("chatModeEnabled", chatModeEnabled)] },
    ],
  };
}

describe("parsePath", () => {
  it.each([
    { input: "/", expected: { name: "chat" } },
    { input: "/workbench", expected: { name: "workbench" } },
    { input: "/share/abc12345/hello-world", expected: { name: "share", shareId: "abc12345", slug: "hello-world" } },
    // share 尾部多余路径不命中，按未知路径回落 chat
    { input: "/share/abc12345/hello-world/extra", expected: { name: "chat" } },
    // 未知路径回落 chat
    { input: "/no-such-page", expected: { name: "chat" } },
  ])("parsePath：$input", ({ input, expected }) => {
    expect(parsePath(input)).toEqual(expected);
  });
});

describe("chatModeEnabled 同步", () => {
  afterEach(() => {
    ui.setChatModeEnabled(false);
  });

  it("readChatModeEnabled：数据未就绪返回 undefined 且不改本地状态", () => {
    // 设置未加载时返回 undefined，不改动本地状态
    ui.setChatModeEnabled(true);
    expect(readChatModeEnabled(undefined)).toBeUndefined();
    expect(uiStore.get().chatModeEnabled).toBe(true);

    // 视图缺该字段时返回 undefined，不改动本地状态
    ui.setChatModeEnabled(true);
    expect(readChatModeEnabled(settingsView())).toBeUndefined();
    expect(uiStore.get().chatModeEnabled).toBe(true);
  });

  it("设置到达后同步 chatModeEnabled：true/false 与非法值按关闭处理", () => {
    // 设置到达后 ui-store 跟随 true
    const enabled = readChatModeEnabled(settingsView(true));
    expect(enabled).toBe(true);
    if (enabled !== undefined) ui.setChatModeEnabled(enabled);
    expect(uiStore.get().chatModeEnabled).toBe(true);

    // 设置为 false 时 ui-store 回落关闭
    ui.setChatModeEnabled(true);
    const disabled = readChatModeEnabled(settingsView(false));
    expect(disabled).toBe(false);
    if (disabled !== undefined) ui.setChatModeEnabled(disabled);
    expect(uiStore.get().chatModeEnabled).toBe(false);

    // 非布尔值按关闭处理
    const view: SettingsView = {
      groups: [{ id: "general", label: "通用", fields: [{ ...booleanField("chatModeEnabled", false), value: "yes" }] }],
    };
    expect(readChatModeEnabled(view)).toBe(false);
  });
});
