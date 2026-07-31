import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAccessSection } from "../components/SettingsDialog";
import { api } from "../lib/api";
import type { SettingsView } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

const selected = JSON.stringify(["主服务", "fast-1"]);
const settings: SettingsView = {
  groups: [{
    id: "fastModel",
    label: "快速模型",
    fields: [
      { key: "fastModel", label: "快速模型", type: "select", options: [{ value: selected, label: "fast-1【主服务】" }], value: null, hasValue: false, source: "default", editable: true, restartRequired: false, nullable: true },
      { key: "fastModelThinking", label: "思考", type: "select", options: [{ value: "disabled", label: "disabled" }, { value: "enabled", label: "enabled" }], value: "disabled", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
      { key: "fastModelEffort", label: "力度", type: "select", options: [{ value: "none", label: "none" }, { value: "high", label: "high" }], value: "none", hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
      { key: "fastModelMaxTokens", label: "最大输出上限", type: "number", value: 4_096, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
    ],
  }],
};

function renderSettings(): ReturnType<typeof renderWithClient> {
  return renderWithClient(<ModelAccessSection />);
}

describe("ModelAccessSection fast model", () => {
  afterEach(() => vi.restoreAllMocks());

  it("selects a catalog model and saves its thinking, effort, and output parameters", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(settings);
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(settings);
    const view = renderSettings();

    const model = await view.findByLabelText("快速模型");
    expect(view.getByRole("option", { name: "fast-1【主服务】" })).toHaveValue(selected);
    fireEvent.change(model, { target: { value: selected } });
    fireEvent.change(view.getByLabelText("思考"), { target: { value: "enabled" } });
    fireEvent.change(view.getByLabelText("力度"), { target: { value: "high" } });
    fireEvent.change(view.getByLabelText("最大输出上限"), { target: { value: "2048" } });
    fireEvent.click(view.getByRole("button", { name: "保存服务设置" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({
      fastModel: selected,
      fastModelThinking: "enabled",
      fastModelEffort: "high",
      fastModelMaxTokens: 2_048,
    }));
  });
});
