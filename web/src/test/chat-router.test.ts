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
  it("/ 落到 chat 路由", () => {
    expect(parsePath("/")).toEqual({ name: "chat" });
  });

  it("/workbench 落到 workbench 路由", () => {
    expect(parsePath("/workbench")).toEqual({ name: "workbench" });
  });

  it("/share/:id/:slug 解析出 shareId 与 slug", () => {
    expect(parsePath("/share/abc12345/hello-world")).toEqual({ name: "share", shareId: "abc12345", slug: "hello-world" });
  });

  it("share 尾部多余路径不命中，按未知路径回落 chat", () => {
    expect(parsePath("/share/abc12345/hello-world/extra")).toEqual({ name: "chat" });
  });

  it("未知路径回落 chat", () => {
    expect(parsePath("/no-such-page")).toEqual({ name: "chat" });
  });
});

describe("chatModeEnabled 同步", () => {
  afterEach(() => {
    ui.setChatModeEnabled(false);
  });

  it("设置未加载时返回 undefined，不改动本地状态", () => {
    ui.setChatModeEnabled(true);
    expect(readChatModeEnabled(undefined)).toBeUndefined();
    expect(uiStore.get().chatModeEnabled).toBe(true);
  });

  it("设置到达后 ui-store 跟随 true", () => {
    const enabled = readChatModeEnabled(settingsView(true));
    expect(enabled).toBe(true);
    if (enabled !== undefined) ui.setChatModeEnabled(enabled);
    expect(uiStore.get().chatModeEnabled).toBe(true);
  });

  it("设置为 false 时 ui-store 回落关闭", () => {
    ui.setChatModeEnabled(true);
    const enabled = readChatModeEnabled(settingsView(false));
    expect(enabled).toBe(false);
    if (enabled !== undefined) ui.setChatModeEnabled(enabled);
    expect(uiStore.get().chatModeEnabled).toBe(false);
  });

  it("视图缺该字段时返回 undefined，不改动本地状态", () => {
    ui.setChatModeEnabled(true);
    expect(readChatModeEnabled(settingsView())).toBeUndefined();
    expect(uiStore.get().chatModeEnabled).toBe(true);
  });

  it("非布尔值按关闭处理", () => {
    const view: SettingsView = {
      groups: [{ id: "general", label: "通用", fields: [{ ...booleanField("chatModeEnabled", false), value: "yes" }] }],
    };
    expect(readChatModeEnabled(view)).toBe(false);
  });
});
