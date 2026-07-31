import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesPanel } from "../components/panels/FilesPanel";
import { api } from "../lib/api";
import type { ManagedWorkspaceSyncPreview, ManagedWorkspaceSyncResult, SessionDetail } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

const session: SessionDetail = {
  id: "managed-session",
  cwd: "C:\\data\\mnt\\managed-session",
  provider: "test",
  model: "test-model",
  title: "托管会话",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  messages: [],
  workspace: {
    mode: "managed",
    backend: "vhdx",
    originCwd: "D:\\projects\\source",
    image: "C:\\data\\workspaces\\managed-session\\base.vhdx",
    mountPoint: "C:\\data\\mnt\\managed-session",
  },
};

const preview: ManagedWorkspaceSyncPreview = {
  baseline: { available: true, createdAt: "2026-07-21T00:00:00.000Z", version: 1 },
  fingerprint: "preview-1",
  changes: [
    { path: "new.txt", action: "create", reason: "managed_changed", baseline: null, origin: null, managed: { kind: "file", sha256: "a", size: 1 }, originChanged: false, managedChanged: true },
    { path: "changed.txt", action: "update", reason: "managed_changed", baseline: { kind: "file", sha256: "a", size: 1 }, origin: { kind: "file", sha256: "a", size: 1 }, managed: { kind: "file", sha256: "b", size: 1 }, originChanged: false, managedChanged: true },
    { path: "conflict.txt", action: "conflict", reason: "both_changed", baseline: { kind: "file", sha256: "a", size: 1 }, origin: { kind: "file", sha256: "b", size: 1 }, managed: { kind: "file", sha256: "c", size: 1 }, originChanged: true, managedChanged: true },
  ],
  summary: { create: 1, update: 1, delete: 0, conflicts: 1, unsupported: 0, unchanged: 0 },
};

function renderPanel(props: Partial<ComponentProps<typeof FilesPanel>> = {}): void {
  renderWithClient(<FilesPanel sessionId={session.id} session={session} onNotice={() => undefined} {...props} />);
}

describe("FilesPanel managed workspace sync", () => {
  afterEach(() => vi.restoreAllMocks());

  it("先显示三方差异，再确认回写无冲突项", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [], truncated: false });
    const previewRequest = vi.spyOn(api, "workspaceSyncPreview").mockResolvedValue(preview);
    const applyRequest = vi.spyOn(api, "syncWorkspace").mockResolvedValue({
      applied: [{ path: "new.txt", action: "create" }, { path: "changed.txt", action: "update" }],
      conflicts: [preview.changes[2]!],
      unsupported: [],
      nextPreview: { ...preview, changes: [preview.changes[2]!], summary: { ...preview.summary, create: 0, update: 0, conflicts: 1 } },
    } satisfies ManagedWorkspaceSyncResult);

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "同步回源" }));

    expect(await screen.findByText("同步回源预览")).toBeInTheDocument();
    expect(screen.getByText("新增 1")).toBeInTheDocument();
    expect(screen.getByText("修改 1")).toBeInTheDocument();
    expect(screen.getByText("冲突 1")).toBeInTheDocument();
    expect(previewRequest).toHaveBeenCalledWith(session.id);

    fireEvent.click(screen.getByRole("button", { name: /确认回写 2 项/ }));
    await waitFor(() => expect(applyRequest).toHaveBeenCalledWith(session.id, { confirm: true, previewFingerprint: "preview-1" }));
  });

  it("无基线旧会话只能在明确选择覆盖冲突后回写", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [], truncated: false });
    const legacy: ManagedWorkspaceSyncPreview = {
      ...preview,
      baseline: { available: false, reason: "missing" },
      fingerprint: "legacy-1",
      changes: [{ ...preview.changes[2]!, reason: "legacy_no_baseline" }],
      summary: { create: 0, update: 0, delete: 0, conflicts: 1, unsupported: 0, unchanged: 0 },
    };
    vi.spyOn(api, "workspaceSyncPreview").mockResolvedValue(legacy);
    const applyRequest = vi.spyOn(api, "syncWorkspace").mockResolvedValue({ applied: [], conflicts: [], unsupported: [], nextPreview: legacy });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "同步回源" }));
    expect(await screen.findByText(/此旧会话没有初始基线/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /确认回写 0 项/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认并覆盖回写" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(applyRequest).not.toHaveBeenCalled();
  });
});
