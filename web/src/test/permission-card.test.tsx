import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionCard } from "../components/PermissionCard";

function renderCard() {
  return render(
    <PermissionCard
      permission={{ requestId: "req-1", tool: "run_command", input: { command: "ls" } }}
      sessionId="s1"
      onDone={() => undefined}
    />,
  );
}

describe("PermissionCard 总是允许确认态", () => {
  it("Esc 取消 3 秒确认态；非确认态下 Esc 是无害空操作", () => {
    renderCard();
    const always = screen.getByRole("button", { name: "总是允许" });

    // 非确认态 Esc：状态不变
    fireEvent.keyDown(always, { key: "Escape" });
    expect(screen.getByRole("button", { name: "总是允许" })).toBeInTheDocument();

    // 第一次点击进入确认态
    fireEvent.click(always);
    const confirm = screen.getByRole("button", { name: "确认总是允许？" });

    // Esc 退出确认态，恢复普通「总是允许」按钮
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.getByRole("button", { name: "总是允许" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认总是允许？" })).toBeNull();
  });
});
