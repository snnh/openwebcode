import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobHeader } from "../components/JobHeader";
import { api } from "../lib/api";
import type { SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "session-1",
  cwd: "C:\\workspace",
  provider: "openai",
  model: "test-model",
  title: "模式切换测试",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["C:\\workspace"], writeRoots: ["C:\\workspace"], denyPaths: [], network: "allow" },
  messages: [],
};

afterEach(() => vi.restoreAllMocks());

describe("JobHeader mode switches", () => {
  it("updates sandbox and snapshot modes while idle", async () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "未启用" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onConfig = vi.fn(async () => undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <JobHeader session={session} agentState="idle" onAbort={() => undefined} onConfig={onConfig} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(api.sandboxCapabilities).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("沙盒模式"), { target: { value: "off" } });
    await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ sandboxMode: "off" }));
    fireEvent.change(screen.getByLabelText("快照模式"), { target: { value: "manual" } });
    await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ snapshotMode: "manual" }));
    expect(screen.getByRole("option", { name: "Windows Sandbox" })).toBeDisabled();
  });

  it("disables both switches while the agent is running", () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: true } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <JobHeader session={session} agentState="thinking" onAbort={() => undefined} onConfig={async () => undefined} />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("沙盒模式")).toBeDisabled();
    expect(screen.getByLabelText("快照模式")).toBeDisabled();
  });

  it("offers an explicit manual snapshot action for an idle managed disk workspace", async () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: true } });
    const onCreateCheckpoint = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const managedSession: SessionDetail = {
      ...session,
      workspace: {
        mode: "managed",
        backend: "vhdx",
        originCwd: "C:\\source-workspace",
        image: "C:\\data\\workspaces\\session-1\\base.vhdx",
        mountPoint: "C:\\data\\mnt\\session-1",
      },
    };

    render(
      <QueryClientProvider client={client}>
        <JobHeader
          session={managedSession}
          agentState="idle"
          onAbort={() => undefined}
          onConfig={async () => undefined}
          onCreateCheckpoint={onCreateCheckpoint}
        />
      </QueryClientProvider>,
    );

    const button = screen.getByRole("button", { name: "创建虚拟磁盘快照" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("keeps the managed-disk snapshot action disabled while the session is running", () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: true } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const managedSession: SessionDetail = {
      ...session,
      workspace: {
        mode: "managed",
        backend: "qcow2",
        originCwd: "/source-workspace",
        image: "/data/workspaces/session-1/base.qcow2",
        mountPoint: "/data/mnt/session-1",
      },
    };

    render(
      <QueryClientProvider client={client}>
        <JobHeader
          session={managedSession}
          agentState="idle"
          running
          onAbort={() => undefined}
          onConfig={async () => undefined}
          onCreateCheckpoint={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "创建虚拟磁盘快照" })).toBeDisabled();
  });
});
