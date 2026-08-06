import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxPanel } from "../components/panels/SandboxPanel";
import { api } from "../lib/api";
import { makeSession } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

const session = makeSession({
  id: "session-1",
  cwd: "C:\\workspace",
  provider: "openai",
  model: "test-model",
  title: "沙盒面板测试",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["C:\\workspace"], writeRoots: ["C:\\workspace"], denyPaths: [], network: "allow" },
});

beforeEach(() => {
  vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ platform: "win32", appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "测试" }, bindLink: { available: false, reason: "测试" } });
  // 默认无执行级别记录（{}）
  vi.spyOn(api, "sessionSandboxStatus").mockResolvedValue({});
});

afterEach(() => vi.restoreAllMocks());

describe("SandboxPanel 平台适配", () => {
  it("win32：默认档模式显示 Job Object 文案", async () => {
    renderWithClient(<SandboxPanel session={session} />);
    await waitFor(() => expect(screen.getByText("兼容模式（Job Object）")).toBeInTheDocument());
  });

  it("linux：存量 jobobject 会话按 landlock 显示（兼容映射）", async () => {
    vi.mocked(api.sandboxCapabilities).mockResolvedValue({ platform: "linux", appcontainer: false, jobobject: true, off: true, wsb: { available: false, reason: "仅 Windows" }, bindLink: { available: false, reason: "仅 Windows" }, bwrap: { available: true } });
    renderWithClient(<SandboxPanel session={session} />);
    await waitFor(() => expect(screen.getByText("强制模式（Landlock）")).toBeInTheDocument());
    expect(screen.queryByText(/Job Object/)).not.toBeInTheDocument();
  });

  it("linux：bubblewrap 会话显示隔离模式文案", async () => {
    vi.mocked(api.sandboxCapabilities).mockResolvedValue({ platform: "linux", appcontainer: false, jobobject: true, off: true, wsb: { available: false, reason: "仅 Windows" }, bindLink: { available: false, reason: "仅 Windows" }, bwrap: { available: true } });
    renderWithClient(<SandboxPanel session={{ ...session, sandboxMode: "bubblewrap" }} />);
    await waitFor(() => expect(screen.getByText("隔离模式（bubblewrap）")).toBeInTheDocument());
  });
});

describe("SandboxPanel 执行级别", () => {
  it("enforced：渲染 ok 徽标与原因文本", async () => {
    vi.mocked(api.sessionSandboxStatus).mockResolvedValue({ sandboxCapability: "enforced", sandboxReason: "Job Object 已应用" });
    renderWithClient(<SandboxPanel session={session} />);

    const pill = await screen.findByText("已强制");
    expect(pill).toHaveClass("pill", "ok");
    expect(screen.getByText("Job Object 已应用")).toBeInTheDocument();
  });

  it("partial：渲染 amber 徽标", async () => {
    vi.mocked(api.sessionSandboxStatus).mockResolvedValue({ sandboxCapability: "partial" });
    renderWithClient(<SandboxPanel session={session} />);
    expect(await screen.findByText("部分生效")).toHaveClass("pill", "amber");
  });

  it("advisory：渲染 danger 徽标", async () => {
    vi.mocked(api.sessionSandboxStatus).mockResolvedValue({ sandboxCapability: "advisory", sandboxReason: "核心不支持" });
    renderWithClient(<SandboxPanel session={session} />);
    expect(await screen.findByText("仅提示")).toHaveClass("pill", "danger");
    expect(screen.getByText("核心不支持")).toBeInTheDocument();
  });

  it("无记录时显示 —", async () => {
    renderWithClient(<SandboxPanel session={session} />);
    await waitFor(() => expect(api.sessionSandboxStatus).toHaveBeenCalledWith("session-1"));
    expect(screen.getByText("执行级别").nextElementSibling?.textContent).toBe("—");
  });
});

describe("SandboxPanel 网络策略", () => {
  it("filtered：显示代理过滤文案", async () => {
    renderWithClient(<SandboxPanel session={{ ...session, sandbox: { ...session.sandbox!, network: "filtered" } }} />);
    await waitFor(() => expect(screen.getByText("代理过滤（仅 Windows）")).toBeInTheDocument());
  });
});
