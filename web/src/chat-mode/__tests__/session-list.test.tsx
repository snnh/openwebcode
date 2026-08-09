// ChatSessionList：重命名走 Overlay 弹层（不调 window.prompt），PATCH 带凭据与标题。
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSessionList } from "../ChatSessionList";

const SESSION = {
  id: "s1",
  title: "旧标题",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  provider: "anthropic",
  model: "claude",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatSessionList 重命名", () => {
  it("走 Overlay 弹层而非 window.prompt，提交后 PATCH title", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ ...SESSION, title: "新标题" }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn();

    const view = render(
      <ChatSessionList sessions={[SESSION]} onSelect={() => undefined} onRefresh={onRefresh} />,
    );

    fireEvent.click(view.getByRole("button", { name: "更多操作" }));
    fireEvent.click(await view.findByRole("button", { name: "重命名" }));

    const input = await view.findByPlaceholderText("对话标题");
    expect(input).toHaveValue("旧标题");
    fireEvent.change(input, { target: { value: "新标题" } });
    fireEvent.click(view.getByRole("button", { name: "确定" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([input, init]) =>
        String(input).includes("/api/chat/sessions/s1") && (init as RequestInit | undefined)?.method === "PATCH");
      expect(patchCall).toBeDefined();
      const init = patchCall![1] as RequestInit;
      expect(init.credentials).toBe("include");
      expect(JSON.parse(String(init.body))).toEqual({ title: "新标题" });
    });
    expect(onRefresh).toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
