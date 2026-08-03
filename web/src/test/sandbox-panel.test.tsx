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
});

afterEach(() => vi.restoreAllMocks());

describe("SandboxPanel 平台适配", () => {
  it("win32：默认档模式显示 Job Object 文案", async () => {
    renderWithClient(<SandboxPanel session={session} />);
    await waitFor(() => expect(screen.getByText("兼容模式（Job Object）")).toBeInTheDocument());
  });

  it("linux：默认档模式显示 Landlock 文案", async () => {
    vi.mocked(api.sandboxCapabilities).mockResolvedValue({ platform: "linux", appcontainer: false, jobobject: true, off: true, wsb: { available: false, reason: "仅 Windows" }, bindLink: { available: false, reason: "仅 Windows" } });
    renderWithClient(<SandboxPanel session={session} />);
    await waitFor(() => expect(screen.getByText("强制模式（Landlock）")).toBeInTheDocument());
    expect(screen.queryByText(/Job Object/)).not.toBeInTheDocument();
  });
});
