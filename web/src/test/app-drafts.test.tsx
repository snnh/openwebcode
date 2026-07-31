import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

const session = makeSession({ title: "草稿测试作业" });

const sessionB = makeSession({ id: "s2", title: "另一个作业" });

function installFetchMock(extraSessions: boolean): void {
  const all = extraSessions ? [session, sessionB] : [session];
  installAppFetchMock({
    session,
    models: [],
    extra: (url, json) => {
      if (url.endsWith("/api/sessions")) return json(all.map(({ id, cwd, provider, model, title, createdAt, updatedAt }) => ({ id, cwd, provider, model, title, createdAt, updatedAt })));
      const detail = all.find((entry) => url.match(new RegExp(`/api/sessions/${entry.id}(\\?.*)?$`)));
      if (detail) return json(detail);
      return undefined;
    },
  });
}

setupStubWebSocket();

describe("App 草稿持久化（localStorage owc-draft-<id>）", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("选中会话时从 localStorage 恢复草稿，并修剪已删除会话的草稿键", async () => {
    window.localStorage.setItem("owc-draft-s1", JSON.stringify("刷新前未发送"));
    window.localStorage.setItem("owc-draft-gone", JSON.stringify("已删会话残留"));
    installFetchMock(false);
    renderApp();

    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    expect(textarea).toHaveValue("刷新前未发送");
    // 会话列表已加载：s1 存在保留，gone 不在列表被修剪
    expect(window.localStorage.getItem("owc-draft-gone")).toBeNull();
    expect(window.localStorage.getItem("owc-draft-s1")).not.toBeNull();
  });

  it("输入实时镜像到 localStorage，清空时删除条目", async () => {
    installFetchMock(false);
    renderApp();

    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    expect(textarea).toHaveValue("");
    fireEvent.change(textarea, { target: { value: "正在输入" } });
    expect(window.localStorage.getItem("owc-draft-s1")).toBe(JSON.stringify("正在输入"));
    fireEvent.change(textarea, { target: { value: "" } });
    expect(window.localStorage.getItem("owc-draft-s1")).toBeNull();
  });

  it("镜像只写变化的草稿键，不重写其他会话", async () => {
    installFetchMock(true);
    renderApp();

    // s1 输入草稿
    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    fireEvent.change(textarea, { target: { value: "一" } });
    expect(window.localStorage.getItem("owc-draft-s1")).toBe(JSON.stringify("一"));

    // 切到 s2 输入草稿
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".session-link")].find((link) => link.textContent?.includes("另一个作业"))!);
    const textareaB = await screen.findByRole("combobox", { name: /消息输入框/ });
    await waitFor(() => expect(textareaB).toHaveValue(""));
    fireEvent.change(textareaB, { target: { value: "二" } });
    expect(window.localStorage.getItem("owc-draft-s2")).toBe(JSON.stringify("二"));

    // 切回 s1，再打一键：只重写 s1 的草稿键
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".session-link")].find((link) => link.textContent?.includes("草稿测试作业"))!);
    const textareaA = await screen.findByRole("combobox", { name: /消息输入框/ });
    await waitFor(() => expect(textareaA).toHaveValue("一"));
    fireEvent.change(textareaA, { target: { value: "一改" } });
    expect(window.localStorage.getItem("owc-draft-s1")).toBe(JSON.stringify("一改"));
    expect(window.localStorage.getItem("owc-draft-s2")).toBe(JSON.stringify("二"));
  });
});
