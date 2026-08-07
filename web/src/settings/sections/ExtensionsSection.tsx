import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ExtensionInfo } from "../../lib/contracts";
import { useI18n } from "../../i18n";
import { ExtensionConfigForm, parseConfigSchema, type ExtensionConfigField } from "./ExtensionConfigForm";
import { useConfirmDialog } from "../../components/ConfirmDialog";

const OFFICIAL_EXTENSION_EN: Record<string, { name: string; description: string }> = {
  "context-manager": { name: "Context Manager", description: "Rolling eviction, context compaction, writeback, and ledger views." },
  "attention-optimizer": { name: "Attention Optimizer", description: "Copies critical constraints and the current task into a context anchor to reduce lost-in-the-middle effects." },
  "content-lens": { name: "Content Lens", description: "Translates messages and explains selected text without adding content to the model context." },
  "pdf-to-image": { name: "PDF to Image", description: "Converts PDF pages into image attachments for models that support image input." },
  "env-sim": { name: "Environment Simulation", description: "Mimic another coding agent's system-prompt style and default tool shapes via a selectable preset." },
};

/** 官方扩展配置字段的英文文案（schema 内嵌中文 title/description，英文界面按字段路径覆盖） */
const OFFICIAL_FIELD_EN: Record<string, Record<string, { title: string; description?: string }>> = {
  "attention-optimizer": {
    mode: { title: "Anchor mode", description: "bottomOnly appends a reference anchor after the last message; full also injects a stable-constraint anchor at the top — more effective but uses more context." },
    anchorBudget: { title: "Anchor budget (chars)", description: "Character cap for copied anchor content; lower-scored entries are dropped beyond it. Clamped to 256–12000." },
  },
  "compact-vault": {
    keepTail: { title: "Tail messages kept", description: "Most recent messages excluded from compaction and archiving." },
    chunkSize: { title: "Messages per archive chunk", description: "Smaller chunks give a finer index but more archive files." },
    recallMaxTokens: { title: "Recall output cap (tokens)", description: "Maximum tokens returned by a single recall_memory call." },
  },
  "content-lens": {
    targetLang: { title: "Target language", description: "Output language for translation and explanations, e.g. zh-CN, en, ja." },
    translate: { title: "Translation", description: "How message translation is triggered, plus the glossary." },
    mode: { title: "Trigger", description: "manual: translate via the button; auto: translate assistant messages automatically; off: hide the translate entry." },
    glossary: { title: "Glossary", description: "Fixed translations, one per line as \"source=target\"." },
  },
  "pdf-to-image": {
    maxPages: { title: "Max pages", description: "Maximum PDF pages converted per attachment, also bounded by the attachment slot limit." },
    dpi: { title: "Render DPI", description: "Page rendering resolution; higher is sharper but larger. Capped at 300." },
    maxDimension: { title: "Longest edge (px)", description: "Pixel cap for the longest output edge; larger pages are scaled down. Capped at 2048." },
  },
  "env-sim": {
    persona: { title: "Preset", description: "The coding-agent preset to mimic; empty means no simulation." },
  },
};

/** 英文界面下按字段 key 覆盖 schema 自带的中文 title/description（递归嵌套组） */
export function localizeConfigFields(
  fields: ExtensionConfigField[] | null,
  overrides: Record<string, { title: string; description?: string }> | undefined,
): ExtensionConfigField[] | null {
  if (!fields || !overrides) return fields;
  return fields.map((field) => localizeField(field, overrides));
}

function localizeField(
  field: ExtensionConfigField,
  overrides: Record<string, { title: string; description?: string }>,
): ExtensionConfigField {
  const override = overrides[field.key];
  return {
    ...field,
    ...(override ? { title: override.title } : {}),
    ...(override?.description ? { description: override.description } : {}),
    ...(field.children ? { children: field.children.map((child) => localizeField(child, overrides)) } : {}),
  };
}

export function ExtensionRow({ extension }: { extension: ExtensionInfo }): ReactElement {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const [json, setJson] = useState(() => JSON.stringify(extension.config, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const displayName = language === "en" ? (OFFICIAL_EXTENSION_EN[extension.id]?.name ?? extension.name) : extension.name;
  const displayDescription = language === "en" ? (OFFICIAL_EXTENSION_EN[extension.id]?.description ?? extension.description) : extension.description;
  const parsedFields = parseConfigSchema(extension.configSchema);
  const configFields = language === "en" ? localizeConfigFields(parsedFields, OFFICIAL_FIELD_EN[extension.id]) : parsedFields;
  const confirm = useConfirmDialog();

  useEffect(() => setJson(JSON.stringify(extension.config, null, 2)), [extension.config]);

  const update = (body: { enabled?: boolean; config?: Record<string, unknown> }): void => {
    setBusy(true);
    setError(undefined);
    api.configureExtension(extension.id, body)
      .then(() => void queryClient.invalidateQueries({ queryKey: ["extensions"] }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("扩展更新失败", "Extension update failed")))
      .finally(() => setBusy(false));
  };

  const saveConfig = (): void => {
    try {
      const value = JSON.parse(json) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("配置必须是 JSON 对象", "Configuration must be a JSON object"));
      update({ config: value as Record<string, unknown> });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("配置 JSON 无效", "Invalid configuration JSON"));
    }
  };

  return (
    <article className="extension-card">
      <header>
        <div>
          <strong>{displayName}</strong>
          <span className="mono">{extension.id} · v{extension.version}</span>
        </div>
        <label className="extension-switch">
          <input type="checkbox" checked={extension.enabled} disabled={busy} onChange={(event) => update({ enabled: event.target.checked })} />
          {extension.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}
        </label>
      </header>
      <p>{displayDescription}</p>
      <div className="extension-badges">
        {extension.builtIn && <span className="pill small">{t("官方内置", "Official")}</span>}
        <span className={`pill small${extension.status === "running" ? " ok" : extension.status === "error" ? " danger" : ""}`}>{extension.status === "running" ? t("运行中", "Running") : extension.status === "disabled" ? t("已停用", "Disabled") : t("异常", "Error")}</span>
        {extension.permissions.map((permission) => <span key={permission} className="pill small">{permission}</span>)}
      </div>
      {extension.id === "context-manager" && <p className="settings-note">{t("驱逐、回写和压缩策略按会话配置，请在底部“上下文”面板中调整。", "Eviction, writeback, and compaction policies are configured per session in the Context panel.")}</p>}
      {extension.id !== "context-manager" && (configFields ? (
        <details>
          <summary>{t("配置", "Configuration")}</summary>
          <ExtensionConfigForm extension={extension} fields={configFields} busy={busy} onSave={(config) => update({ config })} />
        </details>
      ) : Object.keys(extension.config).length > 0 && (
        <details>
          <summary>{t("配置 JSON", "Configuration JSON")}</summary>
          <textarea className="extension-json mono" rows={7} value={json} disabled={busy} onChange={(event) => setJson(event.target.value)} spellCheck={false} />
          <button className="btn small" disabled={busy} onClick={saveConfig}>{busy ? t("保存中…", "Saving…") : t("保存配置", "Save configuration")}</button>
        </details>
      ))}
      {!extension.builtIn && (
        <button className="btn small danger" disabled={busy} onClick={() => {
          confirm.ask({
            title: t("卸载扩展", "Uninstall extension"),
            body: t(`卸载扩展 ${displayName}？其配置会一并删除。`, `Uninstall ${displayName}? Its configuration will also be deleted.`),
            confirmLabel: t("卸载", "Uninstall"),
            onConfirm: () => {
              setBusy(true); setError(undefined);
              api.uninstallExtension(extension.id)
                .then(() => void queryClient.invalidateQueries({ queryKey: ["extensions"] }))
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("卸载失败", "Uninstall failed")))
                .finally(() => setBusy(false));
            },
          });
        }}>{t("卸载扩展", "Uninstall extension")}</button>
      )}
      {extension.error && <p className="settings-error">{extension.error}</p>}
      {error && <p className="settings-error">{error}</p>}
      {confirm.dialogElement}
    </article>
  );
}

export function ExtensionsSection(): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const extensions = useQuery({ queryKey: ["extensions"], queryFn: api.extensions });
  const [installPath, setInstallPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirm = useConfirmDialog();
  if (extensions.isPending) return <p className="muted-empty panel-empty">{t("正在连接 Extension Host…", "Connecting to Extension Host…")}</p>;
  if (extensions.isError || !extensions.data) return <p className="muted-empty panel-empty">{t("无法加载扩展清单。", "Could not load extensions.")}</p>;
  return (
    <>
      <p className="settings-note">{t("扩展运行于独立 Extension Host 子进程；单个钩子超时 5 秒后跳过。v1 扩展是可信代码，安装即代表允许其 manifest 中声明的权限。", "Extensions run in a separate Extension Host process; hooks are skipped after a five-second timeout. v1 extensions are trusted code, and installation grants the permissions declared in their manifest.")}</p>
      <div className="extension-list">{extensions.data.map((extension) => <ExtensionRow key={extension.id} extension={extension} />)}</div>
      <h3>{t("安装本地扩展", "Install local extension")}</h3>
      <p className="settings-note">{t("选择包含 manifest.json 和 index.js 的绝对目录；安装后复制到数据目录 extensions/。", "Enter the absolute path to a directory containing manifest.json and index.js. It will be copied into the data directory's extensions folder.")}</p>
      <div className="settings-inline-form">
        <input className="input" value={installPath} onChange={(event) => setInstallPath(event.target.value)} placeholder="D:\\path\\owc-ext-example" spellCheck={false} />
        <button className="btn small" disabled={busy || !installPath.trim()} onClick={() => {
          confirm.ask({
            title: t("安装扩展", "Install extension"),
            body: t("v1 扩展会作为可信代码在独立进程中运行。确认信任并安装此目录中的代码？", "v1 extensions run as trusted code in a separate process. Trust and install the code in this directory?"),
            confirmLabel: t("安装", "Install"),
            danger: false,
            onConfirm: () => {
              setBusy(true); setError(undefined);
              api.installExtension(installPath.trim())
                .then(() => { setInstallPath(""); void queryClient.invalidateQueries({ queryKey: ["extensions"] }); })
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("安装失败", "Installation failed")))
                .finally(() => setBusy(false));
            },
          });
        }}>{busy ? t("安装中…", "Installing…") : t("安装", "Install")}</button>
      </div>
      {error && <p className="settings-error">{error}</p>}
      {confirm.dialogElement}
    </>
  );
}
