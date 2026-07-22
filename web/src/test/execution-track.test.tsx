import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionTrack } from "../components/ExecutionTrack";
import type { SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "session-1",
  cwd: "C:\\workspace",
  provider: "openai",
  model: "test-model",
  title: "运行失败展示",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["C:\\workspace"], writeRoots: ["C:\\workspace"], denyPaths: [], network: "allow" },
  messages: [{ id: "user-1", role: "user", createdAt: "2026-07-21T00:00:00.000Z", content: [{ type: "text", text: "请处理这个任务" }] }],
};

describe("ExecutionTrack failures", () => {
  it("keeps an agent failure visible in the conversation track", () => {
    render(
      <ExecutionTrack
        session={session}
        streamText=""
        runError="Core sandbox configuration failed"
        permissions={[]}
        onPermissionDone={() => undefined}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("本轮执行失败");
    expect(screen.getByRole("alert")).toHaveTextContent("Core sandbox configuration failed");
  });

  it("virtualizes long message histories instead of mounting every card", () => {
    const longSession: SessionDetail = {
      ...session,
      messages: Array.from({ length: 200 }, (_, index) => ({
        id: `message-${index}`,
        role: "user" as const,
        createdAt: session.createdAt,
        content: [{ type: "text" as const, text: `message ${index}` }],
      })),
    };
    const { container } = render(<ExecutionTrack session={longSession} streamText="" permissions={[]} onPermissionDone={() => undefined} />);
    expect(container.querySelectorAll(".virtual-message-item").length).toBeLessThan(longSession.messages.length);
    expect(container.querySelectorAll(".message").length).toBeLessThan(longSession.messages.length);
  });
});
