/**
 * 设置 → Agent 预设：先预览、再显式应用全局默认；每个预设都可提前编辑，
 * 内置预设保存为同名覆盖；UA 模拟开关也收在这里（扩展页不再展示本扩展）。
 */
import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";
import { presetLabel } from "../../lib/preset-labels";
import { Icon } from "../../components/Icon";
import { SettingsCard, SettingsRow, Switch } from "../controls";
import { PresetCards, PresetCreator, PresetPreview, DeletePresetButton } from "./agent-presets";

export function AgentPresetsSection(): ReactElement {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const presets = useQuery({ queryKey: ["agent-presets"], queryFn: api.agentPresets });
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [uaBusy, setUaBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [applied, setApplied] = useState<string>();
  const [editTarget, setEditTarget] = useState<string>();

  const configured = presets.data?.config?.preset ?? "";
  const simulateUserAgent = presets.data?.config?.simulateUserAgent === true;
  const previewId = preview ?? configured;

  useEffect(() => {
    if (preview === undefined && presets.data) setPreview(presets.data.config.preset);
  }, [presets.data, preview]);

  const previewList = presets.data?.presets ?? [];
  const previewBuiltin = previewList.find((preset) => preset.id === previewId)?.builtin;
  const previewOverridden = previewList.find((preset) => preset.id === previewId)?.overridden === true;
  const configuredLabel = presetLabel(
    previewList.find((preset) => preset.id === configured) ?? { id: "", name: t("经典", "Classic"), description: "" },
    language,
  );
  const previewLabel = presetLabel(
    previewList.find((preset) => preset.id === previewId) ?? { id: "", name: t("经典", "Classic"), description: "" },
    language,
  );
  const previewDetail = useQuery({
    queryKey: ["agent-preset", previewId],
    queryFn: () => api.agentPreset(previewId),
    enabled: previewId !== "",
  });

  const apply = async (value: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setApplied(undefined);
    try {
      await api.configureExtension("agent-presets", { config: { preset: value } });
      await queryClient.invalidateQueries({ queryKey: ["agent-presets"] });
      await queryClient.invalidateQueries({ queryKey: ["extensions"] });
      setPreview(value);
      setApplied(presetLabel(
        previewList.find((preset) => preset.id === value) ?? { id: "", name: t("经典", "Classic"), description: "" },
        language,
      ).name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleUserAgent = async (checked: boolean): Promise<void> => {
    setUaBusy(true);
    setError(undefined);
    try {
      await api.configureExtension("agent-presets", { config: { simulateUserAgent: checked } });
      await queryClient.invalidateQueries({ queryKey: ["agent-presets"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUaBusy(false);
    }
  };

  return (
    <section>
      <SettingsCard
        title={t("全局默认", "Global default")}
        description={t("全局默认仅影响未单独设置预设的会话（含已有会话）；在顶栏覆盖过预设的会话不受影响。", "The global default only affects sessions without their own preset (including existing ones); sessions overridden from the header are unaffected.")}
      >
        <div className="preset-grid-wrap">
          <PresetCards
            current={configured}
            previewed={previewId}
            disabled={busy}
            onPreview={(value) => { setPreview(value); setApplied(undefined); setError(undefined); }}
            onEdit={(value) => { setPreview(value); setApplied(undefined); setError(undefined); setEditTarget(value); }}
          />
          <div className="preset-new">
            <PresetCreator onSaved={(id) => {
              void queryClient.invalidateQueries({ queryKey: ["agent-presets"] });
              setPreview(id);
              setApplied(undefined);
            }} />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("预设详情", "Preset details")}
        description={applied
          ? t(`已设为全局默认：${applied}`, `Set as global default: ${applied}`)
          : t(`正在预览：${previewLabel.name} · 当前默认：${configuredLabel.name}`, `Previewing: ${previewLabel.name} · Current default: ${configuredLabel.name}`)}
      >
        {configured !== "" && !previewList.some((preset) => preset.id === configured) && presets.isSuccess && (
          <p className="settings-note preset-warning">
            {t(`配置中的预设“${configured}”已不存在，当前按经典模式运行；请在下方重新选择并应用。`, `The configured preset “${configured}” no longer exists; classic mode is running. Pick another preset and apply it.`)}
          </p>
        )}
        <SettingsRow
          stack
          label={previewLabel.name}
          description={previewId === "" ? t("基于 PI v1 优化的 OWC 经典提示词框架与全量工具", "OWC's classic prompt framework, tuned from PI v1, with the full tool set.") : previewLabel.description}
        >
          <div className="preset-actions">
            <button
              type="button"
              className="btn small primary"
              disabled={busy || previewId === configured}
              onClick={() => void apply(previewId)}
            >
              <Icon name="check" size={14} />
              {previewId === configured ? t("当前全局默认", "Current global default") : t("设为全局默认", "Set as global default")}
            </button>
            {previewDetail.data && (
              <PresetCreator
                key={previewDetail.data.id}
                source={previewDetail.data}
                autoOpen={editTarget === previewId}
                onOpened={() => setEditTarget(undefined)}
                onSaved={(id) => {
                  void queryClient.invalidateQueries({ queryKey: ["agent-presets"] });
                  void queryClient.invalidateQueries({ queryKey: ["agent-preset", id] });
                  setPreview(id);
                  setApplied(undefined);
                }}
              />
            )}
            {previewDetail.data && (!previewBuiltin || previewOverridden) && (
              <DeletePresetButton
                id={previewId}
                name={previewLabel.name}
                overridden={previewOverridden}
                onDeleted={() => {
                  void queryClient.invalidateQueries({ queryKey: ["agent-presets"] });
                  setPreview(configured);
                }}
              />
            )}
          </div>
        </SettingsRow>
        {previewId !== "" && <PresetPreview id={previewId} />}
        {previewId === "" && (
          <p className="settings-note">{t("经典模式不落盘：它不覆盖任何提示词或工具。", "Classic has no preset file: it overrides nothing.")}</p>
        )}
        {error && <p className="error">{error}</p>}
      </SettingsCard>

      <SettingsCard
        title={t("出站 User-Agent", "Outbound User-Agent")}
        description={t("开启后，出站请求使用当前全局默认预设自带的 UA；经典模式始终使用 OWC 默认 UA。更新检查始终走官方 UA。", "When on, outbound requests use the User-Agent bundled with the current global default preset. Classic mode always uses the OWC default UA; update checks always use the official UA.")}
      >
        <SettingsRow
          inline
          label={t("模拟出站 User-Agent", "Simulate outbound User-Agent")}
          description={configured === "" || configured === "classic" ? t("经典模式没有拟态 UA，切换到带 UA 的预设后才可开启。", "Classic has no simulated UA; switch to a preset that ships one.") : undefined}
          onLabelClick={uaBusy || configured === "" || configured === "classic" ? undefined : () => void toggleUserAgent(!simulateUserAgent)}
        >
          <Switch
            checked={simulateUserAgent}
            onChange={(checked) => void toggleUserAgent(checked)}
            label={t("模拟出站 User-Agent", "Simulate outbound User-Agent")}
            disabled={uaBusy || configured === "" || configured === "classic"}
          />
        </SettingsRow>
      </SettingsCard>
    </section>
  );
}
