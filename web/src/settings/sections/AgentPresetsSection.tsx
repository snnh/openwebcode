/**
 * 设置 → AI 与服务 → Agent 预设：全局默认预设的平铺选择、选前预览、自定义预设管理与复制新建。
 * 会话级覆盖在会话顶栏的预设下拉里（见 SessionHeader）。
 */
import { useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";
import { presetLabel } from "../../lib/preset-labels";
import { PresetCards, PresetCreator, PresetPreview, DeletePresetButton } from "./agent-presets";

export function AgentPresetsSection(): ReactElement {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const extensions = useQuery({ queryKey: ["extensions"], queryFn: api.extensions });
  const presets = useQuery({ queryKey: ["agent-presets"], queryFn: api.agentPresets });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const extension = extensions.data?.find((item) => item.id === "agent-presets");
  const configured = typeof extension?.config.preset === "string" ? extension.config.preset : "";
  const current = presets.data?.presets.find((preset) => preset.id === configured);
  const currentLabel = current ? presetLabel(current, language) : undefined;
  const customPresets = (presets.data?.presets ?? []).filter((preset) => !preset.builtin);
  // 与下方预览共用一个查询键：编辑器回填直接用缓存里的完整详情
  const currentDetail = useQuery({
    queryKey: ["agent-preset", current?.id ?? ""],
    queryFn: () => api.agentPreset(current!.id),
    enabled: Boolean(current),
  });

  const select = async (value: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.configureExtension("agent-presets", { config: { preset: value } });
      await queryClient.invalidateQueries({ queryKey: ["extensions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t("Agent 预设", "Agent presets")}</h3>
      <p className="settings-note">
        {t(
          "新建会话时的默认预设。每个会话都可以在顶栏单独覆盖（或强制回到经典模式）。预设只影响提示词与工具集，不改变 plan/code/goal 模式。",
          "The default preset for new sessions. Each session can override it from the header (or force classic). Presets only change the prompt and tool set; they never touch plan/code/goal mode.",
        )}
      </p>
      {extension && !extension.enabled && (
        <p className="settings-note">{t("扩展「Agent 预设」已停用：预设不生效，全部会话按经典模式运行。", "The Agent presets extension is disabled: presets have no effect and every session runs in classic mode.")}</p>
      )}
      <PresetCards selected={configured} disabled={busy || Boolean(extension && !extension.enabled)} onSelect={(value) => void select(value)} />
      {error && <p className="error">{error}</p>}

      <h3>{t("预设详情", "Preset details")}</h3>
      <p className="settings-note">{t(`当前默认：${currentLabel?.name ?? "经典模式"}`, `Current default: ${currentLabel?.name ?? "Classic"}`)}</p>
      {configured !== "" && !current && presets.isSuccess && (
        <p className="settings-note">{t(`配置里的预设 “${configured}” 已不存在，当前回退为经典模式；请在下方重新选择。`, `The configured preset "${configured}" no longer exists; classic mode is used instead. Pick another preset below.`)}</p>
      )}
      {current && (
        <>
          <PresetPreview id={current.id} />
          {current.overridden === true && (
            <DeletePresetButton
              id={current.id}
              overridden
              onDeleted={() => void queryClient.invalidateQueries({ queryKey: ["agent-presets"] })}
            />
          )}
          {currentDetail.data && (
            <PresetCreator source={currentDetail.data} onCreated={(id) => void select(id)} />
          )}
          <p className="settings-note">
            {t(
              `预设文件位于 ${presets.data?.directory ?? "<数据目录>"}；复制内置预设为自定义预设会在该目录写入覆盖文件，删除即还原。`,
              `Preset files live in ${presets.data?.directory ?? "<data dir>"}; duplicating a built-in writes an override file there, and deleting it restores the built-in.`,
            )}
          </p>
        </>
      )}
      {!current && presets.data && (
        <p className="settings-note">{t("经典模式不落盘：它不覆盖任何提示词或工具。", "Classic has no preset file: it overrides nothing.")}</p>
      )}

      <h3>{t("自定义预设", "Custom presets")}</h3>
      {customPresets.length === 0 && <p className="settings-note">{t("还没有自定义预设。", "No custom presets yet.")}</p>}
      {customPresets.length > 0 && (
        <div className="extension-list">
          {customPresets.map((preset) => (
            <div key={preset.id} className="extension-card">
              <header>
                <div>
                  <strong>{presetLabel(preset, language).name}</strong>
                  <span className="mono">{preset.id}</span>
                </div>
              </header>
              <p>{presetLabel(preset, language).description}</p>
              <DeletePresetButton
                id={preset.id}
                onDeleted={() => void queryClient.invalidateQueries({ queryKey: ["agent-presets"] })}
              />
            </div>
          ))}
        </div>
      )}
      {!current && <PresetCreator onCreated={(id) => void select(id)} />}
    </section>
  );
}