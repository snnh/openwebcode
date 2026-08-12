import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentModeMenu, ModelMenu, PermissionModeMenu } from "../composer/popovers";
import type { ModelProfile } from "../lib/contracts";
import { makeModelProfile } from "./helpers/fixtures";

function renderModelMenu(overrides: Partial<Parameters<typeof ModelMenu>[0]> = {}) {
  const props: Parameters<typeof ModelMenu>[0] = {
    current: { provider: "anthropic", model: "claude-opus-4-8" },
    selectableModels: [makeModelProfile()],
    selectionUnavailable: false,
    effortLevels: ["low", "high"],
    thinkingOn: false,
    defaultOnValue: "mode:enabled",
    thinkingControlSupported: true,
    disabled: false,
    onSelectModel: vi.fn(),
    onSelectThinking: vi.fn(),
    onOpenModelSettings: vi.fn(),
    ...overrides,
  };
  render(<ModelMenu {...props} />);
  return props;
}

describe("PermissionModeMenu", () => {
  it("打开后列出四档，当前值高亮，选择非 yolo 档触发 onChange 并关闭", () => {
    const onChange = vi.fn();
    render(<PermissionModeMenu value="ask" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    const options = screen.getAllByRole("menuitemradio");
    expect(options).toHaveLength(4);
    expect(screen.getByRole("menuitemradio", { name: /逐次确认/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /完全自主/ })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /接受编辑/ }));
    expect(onChange).toHaveBeenCalledWith("acceptEdits");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("选择 yolo 先弹风险确认：勾选后才可确认，确认才切换", () => {
    const onChange = vi.fn();
    render(<PermissionModeMenu value="ask" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /完全自主/ }));
    // 弹层关闭、对话框打开，未勾选前确认禁用且不触发 onChange
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "切换到完全自主？" });
    expect(dialog).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "切换到完全自主" });
    expect(confirm).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(onChange).not.toHaveBeenCalled();
    // 勾选「我已了解风险」后确认可用
    fireEvent.click(screen.getByRole("checkbox", { name: /我已了解风险/ }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onChange).toHaveBeenCalledWith("yolo");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("yolo 确认框取消：不切换；已是 yolo 时重选不再弹确认", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PermissionModeMenu value="ask" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /完全自主/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 已是 yolo：再次选择当前值直接走原路径（仍是 yolo，不重复弹确认）
    rerender(<PermissionModeMenu value="yolo" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /完全自主/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith("yolo");
  });

  it("Esc 关闭弹层，不改变取值", () => {
    const onChange = vi.fn();
    render(<PermissionModeMenu value="review" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    expect(screen.getByRole("menuitemradio", { name: /模型审核/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled 时触发按钮不可点", () => {
    render(<PermissionModeMenu value="ask" disabled onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "权限模式" })).toBeDisabled();
  });
});

describe("AgentModeMenu", () => {
  it("计划/目标写入互斥的 agentMode，Swarm 写独立开关", () => {
    const onConfig = vi.fn();
    render(<AgentModeMenu agentMode={undefined} swarmEnabled={false} disabled={false} onConfig={onConfig} />);
    fireEvent.click(screen.getByRole("button", { name: "模式" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "计划" }));
    expect(onConfig).toHaveBeenCalledWith({ agentMode: "plan" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Swarm" }));
    expect(onConfig).toHaveBeenCalledWith({ swarmEnabled: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "目标" }));
    expect(onConfig).toHaveBeenCalledWith({ agentMode: "goal" });
  });

  it("已激活的模式在按钮徽标与开关态上体现，再次点击计划清除", () => {
    const onConfig = vi.fn();
    render(<AgentModeMenu agentMode="plan" swarmEnabled disabled={false} onConfig={onConfig} />);
    const trigger = screen.getByRole("button", { name: "模式" });
    expect(trigger).toHaveTextContent("计划");
    expect(trigger).toHaveTextContent("Swarm");
    fireEvent.click(trigger);
    expect(screen.getByRole("checkbox", { name: "计划" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Swarm" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "目标" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "计划" }));
    expect(onConfig).toHaveBeenCalledWith({ agentMode: null });
  });
});

describe("ModelMenu", () => {
  it("打开后当前模型选中高亮，选择其他模型触发 onSelectModel 并关闭", () => {
    const models: ModelProfile[] = [makeModelProfile(), makeModelProfile({ id: "claude-sonnet-4-6" })];
    const props = renderModelMenu({ selectableModels: models });
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    expect(screen.getByRole("menuitemradio", { name: "claude-opus-4-8" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "claude-sonnet-4-6" }));
    expect(props.onSelectModel).toHaveBeenCalledWith(models[1]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("多供应商分组：其他组默认折叠，展开后可选", () => {
    const models: ModelProfile[] = [
      makeModelProfile(),
      makeModelProfile({ id: "gpt-5", provider: "openai" }),
    ];
    const props = renderModelMenu({ selectableModels: models });
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    expect(screen.queryByRole("menuitemradio", { name: "gpt-5" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /openai/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gpt-5" }));
    expect(props.onSelectModel).toHaveBeenCalledWith(models[1]);
  });

  it("思考开关与「更多模型…」入口", () => {
    const props = renderModelMenu();
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "思考" }));
    expect(props.onSelectThinking).toHaveBeenCalledWith("mode:enabled");
    fireEvent.click(screen.getByRole("button", { name: "更多模型…" }));
    expect(props.onOpenModelSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("当前模型不在可用清单时顶部固定一条选中态", () => {
    renderModelMenu({ selectionUnavailable: true });
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    expect(screen.getByText("当前模型不在可用清单中")).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-4-8【anthropic】/)).toBeInTheDocument();
  });
});
