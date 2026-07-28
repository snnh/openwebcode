import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionTrack } from "../components/ExecutionTrack";
import { I18nProvider } from "../i18n";
import type { SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "session-1",
  cwd: "C:\\workspace",
  provider: "openai",
  model: "test-model",
  title: "实时活动",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["C:\\workspace"], writeRoots: ["C:\\workspace"], denyPaths: [], network: "allow" },
  messages: [{ id: "user-1", role: "user", createdAt: "2026-07-21T00:00:00.000Z", content: [{ type: "text", text: "请处理这个任务" }] }],
};

function renderTrack(liveActivity?: { state: string; since?: number; currentTool?: string; toolCount: number }) {
  return render(
    <ExecutionTrack
      session={session}
      streamText=""
      permissions={[]}
      onPermissionDone={() => undefined}
      {...(liveActivity ? { liveActivity } : {})}
    />,
  );
}

describe("LiveActivity indicator", () => {
  it("shows the state label and the current tool chip with outstanding count", () => {
    const { container } = renderTrack({ state: "executing_tools", since: Date.now() - 2500, currentTool: "bash", toolCount: 3 });
    const bar = container.querySelector(".live-activity");
    expect(bar).not.toBeNull();
    expect(bar).toHaveTextContent("执行工具");
    expect(bar).toHaveTextContent("bash 等 3 项");
  });

  it("renders the streaming state label in English under I18nProvider", () => {
    window.localStorage.setItem("owc-language", "en");
    render(
      <I18nProvider>
        <ExecutionTrack
          session={session}
          streamText=""
          permissions={[]}
          onPermissionDone={() => undefined}
          liveActivity={{ state: "streaming", since: Date.now() - 1200, toolCount: 0 }}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Responding");
    window.localStorage.removeItem("owc-language");
  });

  it("renders nothing while idle", () => {
    const { container } = renderTrack();
    expect(container.querySelector(".live-activity")).toBeNull();
  });
});
