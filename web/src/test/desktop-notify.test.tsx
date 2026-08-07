import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { SettingsView } from "../lib/contracts";
import {
  desktopNotifyPermission,
  loadDesktopNotifyEnabled,
  maybeDesktopNotify,
  requestDesktopNotifyPermission,
  saveDesktopNotifyEnabled,
} from "../lib/desktop-notify";
import { GeneralSection } from "../settings/sections/GeneralSection";
import { setDesktopNotify, getDesktopNotify } from "../app/prefs-store";
import { renderWithClient } from "./helpers/with-client";

/** 可控的 Notification 假实现：静态 permission/requestPermission + 实例记录 */
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(public readonly title: string, public readonly options?: { body?: string }) {
    FakeNotification.instances.push(this);
  }
}

function stubNotification(permission: NotificationPermission): void {
  FakeNotification.permission = permission;
  FakeNotification.instances = [];
  FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
  vi.stubGlobal("Notification", FakeNotification);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("桌面通知开关持久化", () => {
  it("默认关；save/load 往返", () => {
    expect(loadDesktopNotifyEnabled()).toBe(false);
    saveDesktopNotifyEnabled(true);
    expect(loadDesktopNotifyEnabled()).toBe(true);
    saveDesktopNotifyEnabled(false);
    expect(loadDesktopNotifyEnabled()).toBe(false);
  });
});

describe("desktopNotifyPermission / requestDesktopNotifyPermission", () => {
  it("浏览器不支持 Notification 时返回 unsupported", () => {
    // jsdom 无 Notification；确保全局干净
    vi.stubGlobal("Notification", undefined);
    expect(desktopNotifyPermission()).toBe("unsupported");
  });

  it("已拒绝/已允许状态如实返回", () => {
    stubNotification("denied");
    expect(desktopNotifyPermission()).toBe("denied");
    stubNotification("granted");
    expect(desktopNotifyPermission()).toBe("granted");
  });

  it("仅 default 状态发起浏览器授权请求", async () => {
    stubNotification("granted");
    expect(await requestDesktopNotifyPermission()).toBe("granted");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    stubNotification("default");
    FakeNotification.requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    expect(await requestDesktopNotifyPermission()).toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe("maybeDesktopNotify 失焦门控", () => {
  it("开关关闭时不弹", () => {
    stubNotification("granted");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    expect(maybeDesktopNotify(false, { title: "t", body: "b" })).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("页面可见（document.hidden=false）时不弹", () => {
    stubNotification("granted");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    expect(maybeDesktopNotify(true, { title: "t", body: "b" })).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("浏览器拒绝时不弹", () => {
    stubNotification("denied");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    expect(maybeDesktopNotify(true, { title: "t", body: "b" })).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("开启 + 失焦 + 已授权：弹出通知，点击聚焦窗口并回调", () => {
    stubNotification("granted");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const focus = vi.fn();
    vi.stubGlobal("focus", focus);
    const onClick = vi.fn();
    expect(maybeDesktopNotify(true, { title: "权限待批准", body: "会话A：bash", onClick })).toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe("权限待批准");
    expect(FakeNotification.instances[0]!.options?.body).toBe("会话A：bash");
    FakeNotification.instances[0]!.onclick?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("通用设置：桌面通知开关", () => {
  function renderSection(overrides: { desktopNotify?: boolean } = {}) {
    vi.spyOn(api, "settings").mockResolvedValue({ groups: [] } as unknown as SettingsView);
    setDesktopNotify(overrides.desktopNotify ?? false);
    return renderWithClient(<GeneralSection />);
  }

  it("浏览器已拒绝：设置项如实展示拒绝状态", async () => {
    stubNotification("denied");
    const view = renderSection();
    expect(await view.findByText(/浏览器已拒绝桌面通知权限/)).toBeInTheDocument();
    expect(view.getByRole("checkbox", { name: /页面在后台时弹出系统通知/ })).not.toBeChecked();
  });

  it("开启时请求浏览器授权，授权通过后打开开关", async () => {
    stubNotification("default");
    FakeNotification.requestPermission = vi.fn(async () => {
      FakeNotification.permission = "granted";
      return "granted" as NotificationPermission;
    });
    const view = renderSection();
    fireEvent.click(view.getByRole("checkbox", { name: /页面在后台时弹出系统通知/ }));
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getDesktopNotify()).toBe(true));
  });

  it("开启被拒：开关保持关闭", async () => {
    stubNotification("default");
    FakeNotification.requestPermission = vi.fn(async () => "denied" as NotificationPermission);
    const view = renderSection();
    fireEvent.click(view.getByRole("checkbox", { name: /页面在后台时弹出系统通知/ }));
    await vi.waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalled());
    expect(getDesktopNotify()).toBe(false);
  });
});
