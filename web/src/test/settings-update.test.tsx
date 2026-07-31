import { act, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerInfoSection } from "../components/SettingsDialog";
import { api } from "../lib/api";
import type { UpdateApplyState, VersionInfo } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

function makeState(partial: Partial<UpdateApplyState>): UpdateApplyState {
  return {
    status: "downloading",
    version: "0.6.0",
    progress: null,
    message: "",
    startedAt: "2026-07-27T00:00:00.000Z",
    ...partial,
  };
}

function versionWithRelease(isNewer: boolean): VersionInfo {
  return {
    server: "0.5.2",
    core: "0.5.2",
    githubRepo: "openwebcode/openwebcode",
    latestRelease: {
      version: "0.6.0",
      isNewer,
      htmlUrl: "https://example.com/release",
      publishedAt: "2026-07-26T00:00:00.000Z",
      checkedAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

function stubBaseQueries(isNewer = true): void {
  vi.spyOn(api, "health").mockResolvedValue({ status: "ok" });
  vi.spyOn(api, "version").mockResolvedValue(versionWithRelease(isNewer));
  vi.spyOn(api, "updateCheck").mockResolvedValue({ snapshot: null });
  vi.spyOn(api, "refreshUpdateCheck").mockResolvedValue({ snapshot: null });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("设置：在线更新（update apply）", () => {
  it("有新版本时显示「立即更新」按钮", async () => {
    stubBaseQueries(true);
    const view = renderWithClient(<ServerInfoSection providers={[]} models={[]} />);
    expect(await view.findByRole("button", { name: "立即更新" })).toBeInTheDocument();
  });

  it("已是最新时不显示「立即更新」按钮", async () => {
    stubBaseQueries(false);
    const view = renderWithClient(<ServerInfoSection providers={[]} models={[]} />);
    expect(await view.findByText(/已是最新/)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "立即更新" })).toBeNull();
  });

  it("点击后进入下载状态并展示进度", async () => {
    stubBaseQueries(true);
    const start = vi.spyOn(api, "updateApplyStart")
      .mockResolvedValue({ state: makeState({ status: "downloading", progress: 0.4 }) });
    vi.spyOn(api, "updateApplyStatus").mockResolvedValue({ state: makeState({ status: "downloading", progress: 0.4 }) });
    const view = renderWithClient(<ServerInfoSection providers={[]} models={[]} />);
    fireEvent.click(await view.findByRole("button", { name: "立即更新" }));
    expect(start).toHaveBeenCalledTimes(1);
    const button = await view.findByRole("button", { name: /下载中 40%/ });
    expect(button).toBeDisabled();
    const bar = view.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
  });

  it("轮询同步服务端状态（downloading → verifying）", async () => {
    stubBaseQueries(true);
    vi.spyOn(api, "updateApplyStart")
      .mockResolvedValue({ state: makeState({ status: "downloading", progress: null }) });
    vi.spyOn(api, "updateApplyStatus")
      .mockResolvedValue({ state: makeState({ status: "verifying" }) });
    const view = renderWithClient(<ServerInfoSection providers={[]} models={[]} />);
    const button = await view.findByRole("button", { name: "立即更新" });
    // 初始查询就绪后再切 fake timers，仅接管轮询 interval
    vi.useFakeTimers();
    fireEvent.click(button);
    await act(async () => {});
    expect(view.getByRole("button", { name: "下载中" })).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(view.getByRole("button", { name: "校验中…" })).toBeDisabled();
  });

  it("error 状态展示错误并允许重试", async () => {
    stubBaseQueries(true);
    const start = vi.spyOn(api, "updateApplyStart")
      .mockResolvedValueOnce({ state: makeState({ status: "error", error: "签名不匹配" }) })
      .mockResolvedValueOnce({ state: makeState({ status: "downloading", progress: null }) });
    const view = renderWithClient(<ServerInfoSection providers={[]} models={[]} />);
    fireEvent.click(await view.findByRole("button", { name: "立即更新" }));
    expect(await view.findByRole("alert")).toHaveTextContent("签名不匹配");
    const retry = view.getByRole("button", { name: "重试" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(start).toHaveBeenCalledTimes(2);
    expect(await view.findByRole("button", { name: "下载中" })).toBeDisabled();
  });

  it.each<{ status: UpdateApplyState["status"]; hint: RegExp }>([
    { status: "restarting", hint: /服务即将重启，更新后请刷新页面/ },
    { status: "done", hint: /更新已应用，请手动重启服务后刷新页面/ },
  ])("$status 状态提示对应文案", async ({ status, hint }) => {
    stubBaseQueries(true);
    vi.spyOn(api, "updateApplyStart")
      .mockResolvedValue({ state: makeState({ status }) });
    vi.spyOn(api, "updateApplyStatus")
      .mockResolvedValue({ state: makeState({ status }) });
    const view = renderWithClient(<ServerInfoSection providers={[]} models={[]} />);
    fireEvent.click(await view.findByRole("button", { name: "立即更新" }));
    expect(await view.findByText(hint)).toBeInTheDocument();
  });

  it("POST 被拒绝（400/409/501）时展示错误", async () => {
    stubBaseQueries(true);
    vi.spyOn(api, "updateApplyStart").mockRejectedValue(new Error("已有更新进行中"));
    const view = renderWithClient(<ServerInfoSection providers={[]} models={[]} />);
    fireEvent.click(await view.findByRole("button", { name: "立即更新" }));
    expect(await view.findByRole("alert")).toHaveTextContent("已有更新进行中");
  });
});
