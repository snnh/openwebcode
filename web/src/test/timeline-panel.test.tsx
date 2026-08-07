import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelinePanel } from "../panels/TimelinePanel";
import { api } from "../lib/api";
import type { Checkpoint, SessionTimeline, SnapshotCapabilityInfo } from "../lib/contracts";
import { auxViewsStore } from "../workbench/aux-views";
import { uiStore } from "../app/ui-store";
import { renderWithClient } from "./helpers/with-client";

const checkpoints: Checkpoint[] = [
  { id: "cp-1", label: "初始快照", createdAt: "2026-07-30T00:00:00.000Z", messageCount: 4 },
];

const timeline: SessionTimeline = {
  activeLeafId: "m-2",
  entries: [
    { id: "m-1", role: "user", createdAt: "2026-07-30T00:00:00.000Z" },
    { id: "m-2", role: "assistant", createdAt: "2026-07-30T00:00:01.000Z", runId: "run-1" },
  ],
};

const capability: SnapshotCapabilityInfo = { backend: "git-shadow", costHint: "instant", requiresAdmin: false };

beforeEach(() => {
  auxViewsStore.set({ diff: undefined });
  uiStore.set({ sessionId: "s-1" });
  vi.spyOn(api, "checkpoints").mockResolvedValue(checkpoints);
  vi.spyOn(api, "timeline").mockResolvedValue(timeline);
  vi.spyOn(api, "snapshotCapability").mockResolvedValue(capability);
});

afterEach(() => {
  auxViewsStore.set({ diff: undefined });
  vi.restoreAllMocks();
});

describe("TimelinePanel", () => {
  it("无会话时显示引导空态", () => {
    renderWithClient(<TimelinePanel running={false} />);
    expect(screen.getByText("选择会话以查看检查点。")).toBeInTheDocument();
  });

  it("展示会话树、后端徽标与检查点列表；当前叶节点标记且不可检出", async () => {
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);

    expect(await screen.findByText(/会话树 · 2 个节点/)).toBeInTheDocument();
    expect(screen.getByText("当前")).toBeInTheDocument();
    expect(screen.getByText(/git-shadow · 即时 CoW/)).toBeInTheDocument();
    expect(screen.getByText("初始快照")).toBeInTheDocument();
    // 当前叶节点的「继续」按钮禁用
    const current = document.querySelector(".timeline-node.active")!;
    expect(current.querySelector<HTMLButtonElement>(".copy-btn")!.disabled).toBe(true);
  });

  it("「继续」检出到该节点，「分叉」创建新会话并切换", async () => {
    const checkout = vi.spyOn(api, "checkoutSession").mockResolvedValue({} as never);
    const fork = vi.spyOn(api, "forkSession").mockResolvedValue({ sessionId: "s-2" } as never);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);

    await screen.findByText(/会话树 · 2 个节点/);
    const first = document.querySelectorAll(".timeline-node")[0]!;
    fireEvent.click(first.querySelectorAll("button")[0]!);
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("s-1", "m-1"));

    fireEvent.click(first.querySelectorAll("button")[1]!);
    await waitFor(() => expect(fork).toHaveBeenCalledWith("s-1", { messageId: "m-1" }));
    await waitFor(() => expect(uiStore.get().sessionId).toBe("s-2"));
  });

  it("「新建」创建检查点并刷新列表", async () => {
    const create = vi.spyOn(api, "createCheckpoint").mockResolvedValue({} as never);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /新建/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("s-1"));
  });

  it("运行中禁用新建/回滚操作", async () => {
    renderWithClient(<TimelinePanel sessionId="s-1" running={true} />);
    expect(await screen.findByRole("button", { name: /新建/ })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "完整回滚" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "仅文件" })).toBeDisabled();
  });

  it("展开检查点：内联 diff + 「在 diff 视图中打开」写入 auxViews", async () => {
    vi.spyOn(api, "checkpointDiff").mockResolvedValue({ diff: "diff --git a/x b/x" } as never);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);

    fireEvent.click(await screen.findByText("初始快照"));
    expect(await screen.findByText(/diff --git/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /在 diff 视图中打开/ }));
    expect(auxViewsStore.get().diff).toEqual({ source: "checkpoint", checkpointId: "cp-1", label: "初始快照" });
  });

  it("删除检查点需确认，确认后调用 deleteCheckpoint", async () => {
    const del = vi.spyOn(api, "deleteCheckpoint").mockResolvedValue({} as never);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);

    fireEvent.click(await screen.findByRole("button", { name: "删除该检查点" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("s-1", "cp-1"));
  });

  it("overlayfs 后端显示只读提示", async () => {
    vi.mocked(api.snapshotCapability).mockResolvedValue({ backend: "overlayfs", costHint: "instant", requiresAdmin: false });
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);
    expect(await screen.findByText(/源目录只读/)).toBeInTheDocument();
  });

  it("无检查点时显示空态", async () => {
    vi.mocked(api.checkpoints).mockResolvedValue([]);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);
    expect(await screen.findByText("暂无检查点。")).toBeInTheDocument();
  });
});
