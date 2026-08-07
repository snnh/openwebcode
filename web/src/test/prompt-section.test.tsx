import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptSection } from "../settings/sections/PromptSection";
import { api } from "../lib/api";
import type { PromptOverrideView, Session } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

const globalView: PromptOverrideView = {
  builtinBase: "内置基线",
  builtinInitPrompt: "内置 init",
  builtinCompactOverviewPrompt: "内置概览压缩",
  builtinCompactToolcallsPrompt: "内置工具压缩",
  promptVersion: "v-test",
  identityOverride: "全局身份",
  baseOverride: "全局基线",
  customAppend: "全局追加",
  subAgentAppend: "全局子代理",
  initOverride: "全局 init",
  compactOverviewOverride: null,
  compactToolcallsOverride: null,
};

const projectView: PromptOverrideView = {
  builtinBase: "内置基线",
  builtinInitPrompt: "内置 init",
  builtinCompactOverviewPrompt: "内置概览压缩",
  builtinCompactToolcallsPrompt: "内置工具压缩",
  promptVersion: "v-test",
  identityOverride: null,
  baseOverride: "项目基线",
  customAppend: null,
  subAgentAppend: "项目子代理",
  initOverride: null,
  compactOverviewOverride: "项目概览压缩",
  compactToolcallsOverride: null,
};

const session = { id: "s1", cwd: "/work/demo", provider: "p", model: "m", title: "demo", createdAt: "", updatedAt: "" } as unknown as Session;

function stubPromptApis(): void {
  vi.spyOn(api, "sessions").mockResolvedValue([session]);
  vi.spyOn(api, "promptOverride").mockImplementation(async (opts) => (opts?.scope === "project" ? projectView : globalView));
  vi.spyOn(api, "savePromptOverride").mockResolvedValue({ ok: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PromptSection", () => {
  it("默认全局作用域渲染七个配置面并加载全局值", async () => {
    stubPromptApis();
    renderWithClient(<PromptSection sessionCwd="/work/demo" />);
    await waitFor(() => expect(screen.getByLabelText("身份行")).toHaveValue("全局身份"));
    expect(screen.getByLabelText("基线覆盖")).toHaveValue("全局基线");
    expect(screen.getByLabelText("追加指令")).toHaveValue("全局追加");
    expect(screen.getByLabelText("子代理附加指令")).toHaveValue("全局子代理");
    expect(screen.getByLabelText("/init 提示词")).toHaveValue("全局 init");
    expect(screen.getByLabelText("压缩提示词（概览）")).toHaveValue("");
    expect(screen.getByLabelText("压缩提示词（工具调用）")).toHaveValue("");
  });

  it("切换到当前项目作用域后按项目值渲染，切回全局恢复", async () => {
    stubPromptApis();
    renderWithClient(<PromptSection sessionCwd="/work/demo" />);
    await waitFor(() => expect(screen.getByLabelText("基线覆盖")).toHaveValue("全局基线"));

    fireEvent.click(screen.getByRole("button", { name: /当前项目/ }));
    await waitFor(() => expect(screen.getByLabelText("基线覆盖")).toHaveValue("项目基线"));
    expect(api.promptOverride).toHaveBeenCalledWith({ scope: "project", cwd: "/work/demo" });
    expect(screen.getByLabelText("身份行")).toHaveValue("");
    expect(screen.getByLabelText("子代理附加指令")).toHaveValue("项目子代理");

    fireEvent.click(screen.getByRole("button", { name: "全局" }));
    await waitFor(() => expect(screen.getByLabelText("基线覆盖")).toHaveValue("全局基线"));
  });

  it("保存按当前作用域提交七个面（空串转 null）并上报 dirty", async () => {
    stubPromptApis();
    const onDirtyChange = vi.fn();
    renderWithClient(<PromptSection sessionCwd="/work/demo" onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(screen.getByLabelText("追加指令")).toHaveValue("全局追加"));

    fireEvent.change(screen.getByLabelText("追加指令"), { target: { value: "改成新的追加" } });
    fireEvent.change(screen.getByLabelText("压缩提示词（概览）"), { target: { value: "自定义概览压缩" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.savePromptOverride).toHaveBeenCalledWith({
      scope: "global",
      identityOverride: "全局身份",
      baseOverride: "全局基线",
      customAppend: "改成新的追加",
      subAgentAppend: "全局子代理",
      initOverride: "全局 init",
      compactOverviewOverride: "自定义概览压缩",
      compactToolcallsOverride: null,
    }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("项目作用域保存携带 cwd", async () => {
    stubPromptApis();
    renderWithClient(<PromptSection sessionCwd="/work/demo" />);
    await waitFor(() => expect(screen.getByLabelText("基线覆盖")).toHaveValue("全局基线"));
    fireEvent.click(screen.getByRole("button", { name: /当前项目/ }));
    await waitFor(() => expect(screen.getByLabelText("基线覆盖")).toHaveValue("项目基线"));

    fireEvent.change(screen.getByLabelText("身份行"), { target: { value: "项目身份" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.savePromptOverride).toHaveBeenCalledWith({
      scope: "project",
      cwd: "/work/demo",
      identityOverride: "项目身份",
      baseOverride: "项目基线",
      customAppend: null,
      subAgentAppend: "项目子代理",
      initOverride: null,
      compactOverviewOverride: "项目概览压缩",
      compactToolcallsOverride: null,
    }));
  });

  it("无会话时禁用项目档并给出说明", async () => {
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "promptOverride").mockResolvedValue(globalView);
    renderWithClient(<PromptSection />);
    await waitFor(() => expect(screen.getByLabelText("基线覆盖")).toHaveValue("全局基线"));
    expect(screen.getByRole("button", { name: "当前项目" })).toBeDisabled();
    expect(screen.getByText(/项目作用域不可用/)).toBeInTheDocument();
  });
});
