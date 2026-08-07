import * as axeCore from "axe-core";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewSessionDialog } from "../components/NewSessionDialog";
import { NotificationsSection } from "../components/settings/NotificationsSection";
import { SettingsDialog } from "../components/SettingsDialog";
import { ScmView } from "../workbench/sidebar/ScmView";
import { api } from "../lib/api";
import type { PricingDocument, PromptOverrideView, ScmStatus, SettingsView } from "../lib/contracts";
import type { AppNotification } from "../lib/notifications";
import { renderWithClient } from "./helpers/with-client";

// 对话框/面板打开态的 axe 断言。mock 手段沿用各组件既有测试（settings-dirty / new-session-dialog / scm-panel）。
// axe 结果统一断言 violations 为空；若组件结构变化引入违规，应修组件而非放宽此处。

async function expectNoViolations(container: HTMLElement): Promise<void> {
  const results = await axeCore.run(container);
  expect(results.violations).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsDialog 打开态无障碍", () => {
  const settingsView: SettingsView = {
    groups: [{
      id: "updateCheck",
      label: "更新检查",
      fields: [
        { key: "updateCheckEnabled", label: "启用更新检查", type: "boolean", value: true, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
      ],
    }],
  };
  const pricingCatalog: PricingDocument = { version: 1, updatedAt: "2026-07-20T00:00:00.000Z", entries: [] };
  const promptView: PromptOverrideView = { builtinBase: "内置基线", promptVersion: "v-test", baseOverride: null, customAppend: null };

  it("默认外观页签打开时无 axe 违规", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settingsView);
    vi.spyOn(api, "health").mockResolvedValue({ status: "ok" });
    vi.spyOn(api, "version").mockResolvedValue({ server: "0.7.0", core: "0.7.0", githubRepo: "snnh/openwebcode" });
    vi.spyOn(api, "updateCheck").mockRejectedValue(new Error("not enabled"));
    vi.spyOn(api, "refreshUpdateCheck").mockRejectedValue(new Error("not enabled"));
    vi.spyOn(api, "modelPricing").mockResolvedValue(pricingCatalog);
    vi.spyOn(api, "promptOverride").mockResolvedValue(promptView);

    const { container } = renderWithClient(
      <SettingsDialog
        open
        preference="system"
        setPreference={() => undefined}
        accent="teal"
        setAccent={() => undefined}
        sendKey="enter"
        setSendKey={() => undefined}
        desktopNotify={false}
        setDesktopNotify={() => undefined}
        defaults={{}}
        setDefaults={() => undefined}
        providers={[]}
        models={[]}
        notifications={[]}
        onActivateNotification={() => undefined}
        onDismissNotification={() => undefined}
        onClearAllNotifications={() => undefined}
        onMarkAllRead={() => undefined}
        onResetLayout={() => undefined}
        onClose={() => undefined}
      />,
    );
    // 等待打开态的数据拉取落定
    await screen.findByRole("button", { name: "关闭" });
    await expectNoViolations(container);
  });
});

describe("NewSessionDialog 打开态无障碍", () => {
  it("对话框打开且能力数据加载后无 axe 违规", async () => {
    const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/sandbox/capabilities")) return json({ platform: "win32", appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "未启用" }, bindLink: { available: false, reason: "未启用" } });
      if (url.endsWith("/api/managed-workspace/capability")) return json({ platform: "linux", backends: [{ backend: "qcow2", available: false, requiresAdmin: true, detail: "不可用" }] });
      return json({ error: "not mocked" }, 404);
    });
    vi.stubGlobal("fetch", handler);

    const { container } = renderWithClient(
      <NewSessionDialog open providers={["test-stub"]} models={[]} onClose={() => undefined} onCreate={() => undefined} />,
    );
    await screen.findByText("工作区模式");
    await expectNoViolations(container);
  });
});

describe("NotificationsSection 打开态无障碍", () => {
  it("有通知时无 axe 违规", async () => {
    const notifications: AppNotification[] = [
      { id: "n1", kind: "info", text: "后台任务已结束", at: Date.UTC(2026, 6, 25, 10, 30), read: false },
      { id: "n2", kind: "error", text: "诊断更新：2 项失败", at: Date.UTC(2026, 6, 25, 11, 0), read: true },
    ];
    const { container } = render(
      <NotificationsSection notifications={notifications} onActivate={vi.fn()} onDismiss={vi.fn()} onClearAll={vi.fn()} onMarkAllRead={vi.fn()} />,
    );
    await screen.findByRole("region", { name: "通知中心" });
    await expectNoViolations(container);
  });
});

describe("ScmPanel 有内容态无障碍", () => {
  it("存在变更的 git 状态下无 axe 违规", async () => {
    const status: ScmStatus = {
      isRepo: true,
      branch: "main",
      ahead: 2,
      behind: 1,
      staged: [{ path: "src/staged.ts", code: "M " }],
      unstaged: [
        { path: "src/app.ts", code: " M" },
        { path: "README.md", code: " D" },
      ],
      untracked: [{ path: "notes.txt", code: "??" }],
      totals: { staged: 1, unstaged: 2, untracked: 1 },
      truncated: false,
    };
    vi.spyOn(api, "scmStatus").mockResolvedValue(status);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);

    const { container } = renderWithClient(<ScmView sessionId="s1" />);
    // 等待三组变更渲染完成
    await screen.findByText("已暂存的更改");
    await screen.findByText("notes.txt");
    await expectNoViolations(container);
  });
});
