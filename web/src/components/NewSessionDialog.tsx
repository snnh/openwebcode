import { useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import type { ManagedWorkspaceCapability, ModelProfile, PermissionMode, SandboxCapabilities, SandboxMode } from "../lib/contracts";
import type { SessionDefaults } from "../lib/prefs";
import { useI18n } from "../i18n";
import { ModelCapabilityBadges } from "./ModelCapabilityBadges";

export interface NewSessionValues {
  cwd: string;
  title?: string;
  provider: string;
  model: string;
  agentMode?: "plan" | "code" | "goal";
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  setupScript?: string;
  workspaceMode?: "managed";
  bindLinks?: { virtPath: string; backingPath: string; readOnly?: boolean }[];
}

const SANDBOX_MODE_LABELS: Record<SandboxMode, [string, string]> = {
  appcontainer: ["应用容器（AppContainer）", "AppContainer"],
  wsb: ["Windows Sandbox（不可信代码）", "Windows Sandbox (untrusted code)"],
  jobobject: ["兼容模式（Job Object，默认）", "Compatibility (Job Object, default)"],
  off: ["关闭沙盒", "Sandbox off"],
};

export function NewSessionDialog({ open, providers, models, defaults, busy = false, onClose, onCreate, onOpenSettings }: {
  open: boolean;
  providers: string[];
  models: ModelProfile[];
  defaults?: SessionDefaults;
  busy?: boolean;
  onClose(): void;
  onCreate(values: NewSessionValues): void;
  /** 深链到设置页签（模型目录 models）；不提供时提示保持纯文本 */
  onOpenSettings?(tab: "models"): void;
}): ReactElement | null {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("jobobject");
  const [setupScript, setSetupScript] = useState("");
  const [sandboxCaps, setSandboxCaps] = useState<SandboxCapabilities | undefined>();
  const [workspaceMode, setWorkspaceMode] = useState<"direct" | "managed">("direct");
  const [agentMode, setAgentMode] = useState<"plan" | "code" | "goal">("code");
  const [managedCaps, setManagedCaps] = useState<ManagedWorkspaceCapability | undefined>();
  const [bindLinks, setBindLinks] = useState<{ virtPath: string; backingPath: string; readOnly: boolean }[]>([]);

  const dialogModels = models.filter((item) => providers.includes(item.provider));
  const selectedModel = dialogModels.find((item) => item.id === model && item.provider === provider);
  const selection = JSON.stringify([provider, model]);

  useEffect(() => {
    if (!open) return;
    const current = dialogModels.find((item) => item.provider === provider && item.id === model);
    const preset = defaults?.provider && defaults.model
      ? dialogModels.find((item) => item.provider === defaults.provider && item.id === defaults.model)
      : undefined;
    const next = current ?? preset ?? dialogModels[0];
    setProvider(next?.provider ?? "");
    setModel(next?.id ?? "");
    if (defaults?.permissionMode) setPermissionMode(defaults.permissionMode);
    // dialogModels is derived from these dependencies; retaining a valid current
    // pair avoids resetting a user's selection when the catalog refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providers, models, defaults]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // 打开时并行拉取沙盒能力（WSB 不可用则禁用对应选项）与托管工作区能力；失败按不可用处理
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.sandboxCapabilities()
      .then((caps) => { if (!cancelled) setSandboxCaps(caps); })
      .catch(() => undefined);
    api.managedWorkspaceCapability()
      .then((caps) => { if (!cancelled) setManagedCaps(caps); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  const bindLinkCap = sandboxCaps?.bindLink;
  const bindLinkAvailable = bindLinkCap?.available ?? false;
  // 只提交两个路径都填了的行；未填完整的行静默忽略
  const validBindLinks = bindLinks
    .map((link) => ({ virtPath: link.virtPath.trim(), backingPath: link.backingPath.trim(), ...(link.readOnly ? { readOnly: true as const } : {}) }))
    .filter((link) => link.virtPath.length > 0 && link.backingPath.length > 0);

  const fallbackTitle = cwd.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
  const noProviders = providers.length === 0;
  const noModels = !noProviders && dialogModels.length === 0;
  const managedAvailable = managedCaps?.backends.some((item) => item.available) ?? false;
  const managedUnavailableReason = managedCaps === undefined
    ? t("能力检测中…", "Detecting capabilities…")
    : managedCaps.backends.map((item) => item.detail).filter(Boolean).join(t("；", "; ")) || t("当前平台不支持托管工作区", "Managed workspaces are not supported on this platform");

  return (
    <dialog
      ref={dialogRef}
      className="session-dialog"
      onClose={onClose}
      onClick={(event) => {
        // 点击背板关闭
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || noProviders || noModels || !cwd.trim() || !model) return;
          onCreate({
            cwd: cwd.trim(),
            title: title.trim() || fallbackTitle || t("新会话", "New session"),
            provider,
            model,
            agentMode,
            permissionMode,
            // jobobject 是缺省，不必显式提交；setupScript 仅 wsb 有意义
            ...(sandboxMode !== "jobobject" ? { sandboxMode } : {}),
            ...(sandboxMode === "wsb" && setupScript.trim() ? { setupScript: setupScript.trim() } : {}),
            ...(workspaceMode === "managed" ? { workspaceMode } : {}),
            ...(validBindLinks.length ? { bindLinks: validBindLinks } : {}),
          });
        }}
      >
        <h2>{t("新建会话", "New session")}</h2>
        <label>
          {t("工作区模式", "Workspace mode")}
          <select value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as "direct" | "managed")}>
            <option value="direct">{t("直接（默认）", "Direct (default)")}</option>
            <option value="managed" disabled={!managedAvailable} title={managedAvailable ? undefined : managedUnavailableReason}>
              {t("托管工作区（镜像盘隔离）", "Managed workspace (disk-image isolation)")}
            </option>
          </select>
        </label>
        {managedCaps && !managedAvailable && (
          <p className="dialog-hint">{t("托管工作区不可用：", "Managed workspace unavailable: ")}{managedUnavailableReason}</p>
        )}
        {workspaceMode === "managed" && (
          <p className="dialog-hint">{t("将创建 20GB 稀疏镜像盘并挂载到数据根 mnt/ 目录，源目录内容（排除 node_modules 等）会复制进去；需要管理员（Hyper-V）或 root（qemu-nbd）权限。源目录不会在关闭或删除会话时自动覆盖；可在“文件”面板随时预览差异并确认同步回源。", "A 20 GB sparse disk image will be created and mounted under mnt/ in the data root. Source contents (excluding node_modules and similar paths) are copied into it. Administrator (Hyper-V) or root (qemu-nbd) access is required. Closing or deleting the session never overwrites the source directory automatically; use the Files panel to preview changes and explicitly sync them back at any time.")}</p>
        )}
        <label>
          {workspaceMode === "managed" ? t("源目录（将复制进托管工作区）", "Source directory (copied into managed workspace)") : t("工作目录", "Working directory")}
          <input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder={t("绝对路径，如 D:\\projects\\demo 或 /home/me/demo", "Absolute path, such as D:\\projects\\demo or /home/me/demo")}
            required
            autoFocus
          />
        </label>
        <label>
          {t("标题（可选）", "Title (optional)")}
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={fallbackTitle || t("默认为目录名", "Defaults to directory name")}
          />
        </label>
        {noProviders && (
          <p className="dialog-hint">{t("还没有可用的 Provider，请先在 设置 → 模型目录 配置 Provider 和 API Key", "No providers are available. Configure a provider and API key under Settings → Models first.")}{onOpenSettings && <>{" "}<button type="button" className="dialog-hint-link" onClick={() => onOpenSettings("models")}>{t("前往配置 →", "Configure →")}</button></>}</p>
        )}
        <label>
          {t("模型", "Model")}
          <select value={selection} disabled={noProviders || noModels} onChange={(event) => {
            const next = dialogModels.find((item) => JSON.stringify([item.provider, item.id]) === event.target.value || item.id === event.target.value);
            if (next) {
              setProvider(next.provider);
              setModel(next.id);
            }
          }}>
            {noModels && <option value="">{t("暂无可用模型", "No model available")}</option>}
            {dialogModels.map((item) => {
              const value = JSON.stringify([item.provider, item.id]);
              return <option key={value} value={value}>{`${item.id}【${item.provider}】`}</option>;
            })}
          </select>
        </label>
        {selectedModel && (
          <div className="model-capability-summary" aria-label={t("所选模型能力", "Selected model capabilities")}>
            <span className="model-capability-summary-label">{t("能力", "Capabilities")}</span>
            <ModelCapabilityBadges capabilities={selectedModel.capabilities} />
          </div>
        )}
        {noModels && (
          <p className="dialog-hint">{t("已启用的服务商尚无可用模型。请在设置中刷新模型列表，或为服务商手动添加模型。", "Enabled providers have no models. Refresh the model catalog or add a manual model for a provider in Settings.")}{onOpenSettings && <>{" "}<button type="button" className="dialog-hint-link" onClick={() => onOpenSettings("models")}>{t("前往模型目录 →", "Open catalog →")}</button></>}</p>
        )}
        <label>
          {t("模式", "Mode")}
          <select value={agentMode} onChange={(event) => setAgentMode(event.target.value as "plan" | "code" | "goal")}>
            <option value="code">{t("代码模式（Code）", "Code")}</option>
            <option value="plan">{t("计划模式（Plan）", "Plan")}</option>
            <option value="goal">{t("目标模式（Goal）", "Goal")}</option>
          </select>
        </label>
        <label>
          {t("权限模式", "Permission mode")}
          <select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}>
            <option value="ask">{t("每次确认", "Ask every time")}</option>
            <option value="acceptEdits">{t("接受编辑", "Accept edits")}</option>
            <option value="review">{t("模型审核", "Model review")}</option>
            <option value="yolo">YOLO</option>
          </select>
        </label>
        <label>
          {t("沙盒模式", "Sandbox mode")}
          <select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as SandboxMode)}>
            {(Object.keys(SANDBOX_MODE_LABELS) as SandboxMode[]).map((mode) => (
              <option key={mode} value={mode} disabled={mode === "wsb" && sandboxCaps !== undefined && !sandboxCaps.wsb.available}>
                {t(...SANDBOX_MODE_LABELS[mode])}
              </option>
            ))}
          </select>
        </label>
        {sandboxCaps && !sandboxCaps.wsb.available && (
          <p className="dialog-hint">{t("Windows Sandbox 不可用：", "Windows Sandbox unavailable: ")}{sandboxCaps.wsb.reason ?? t("未启用可选功能", "optional feature is not enabled")}</p>
        )}
        {sandboxMode === "wsb" && (
          <label>
            {t("初始化脚本（可选）", "Setup script (optional)")}
            <input
              value={setupScript}
              onChange={(event) => setSetupScript(event.target.value)}
              placeholder={t("沙盒启动后、agent 启动前执行的命令", "Command to run after the sandbox starts and before the agent starts")}
            />
          </label>
        )}
        {(sandboxMode === "jobobject" || sandboxMode === "appcontainer") && (
          <div className="bindlink-editor">
            <div className="bindlink-editor-header">
              <span>{t("目录绑定（Bind Link，可选）", "Directory bindings (Bind Link, optional)")}</span>
              <button
                type="button"
                className="btn"
                disabled={bindLinks.length >= 16 || (sandboxCaps !== undefined && !bindLinkAvailable)}
                onClick={() => setBindLinks([...bindLinks, { virtPath: "", backingPath: "", readOnly: true }])}
              >
                {t("添加绑定", "Add binding")}
              </button>
            </div>
            {bindLinkCap && !bindLinkAvailable && (
              <p className="dialog-hint">{t("Bind Link 不可用：", "Bind Link unavailable: ")}{bindLinkCap.reason ?? t("当前平台 core 未提供 Bind Link 能力", "Bind Link capability is not available on this platform")}</p>
            )}
            {bindLinks.map((link, index) => (
              <div className="bindlink-row" key={index}>
                <input
                  value={link.virtPath}
                  onChange={(event) => setBindLinks(bindLinks.map((item, i) => (i === index ? { ...item, virtPath: event.target.value } : item)))}
                  placeholder={t("沙盒内路径，如 C:\\mnt\\shared", "In-sandbox path, such as C:\\mnt\\shared")}
                  aria-label={t("沙盒内路径", "In-sandbox path")}
                />
                <input
                  value={link.backingPath}
                  onChange={(event) => setBindLinks(bindLinks.map((item, i) => (i === index ? { ...item, backingPath: event.target.value } : item)))}
                  placeholder={t("宿主目录，如 D:\\shared", "Host directory, such as D:\\shared")}
                  aria-label={t("宿主目录", "Host directory")}
                />
                <label className="bindlink-readonly">
                  <input
                    type="checkbox"
                    checked={link.readOnly}
                    onChange={(event) => setBindLinks(bindLinks.map((item, i) => (i === index ? { ...item, readOnly: event.target.checked } : item)))}
                  />
                  {t("只读", "Read-only")}
                </label>
                <button type="button" className="btn" onClick={() => setBindLinks(bindLinks.filter((_, i) => i !== index))}>{t("移除", "Remove")}</button>
              </div>
            ))}
            {bindLinks.length > 0 && (
              <p className="dialog-hint">{t("Bind Link 需要 Windows 11 24H2+ 且 server 以管理员权限运行；沙盒内路径是进程可见的挂载点，按只读/可写映射到宿主目录。", "Bind Link requires Windows 11 24H2+ and an elevated server; the in-sandbox path is the mount point processes see, mapped to the host directory with the chosen writability.")}</p>
            )}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>{t("取消", "Cancel")}</button>
          <button type="submit" className="btn primary" disabled={busy || noProviders || noModels || !cwd.trim() || !model}>{busy ? t("创建中…", "Creating…") : t("创建", "Create")}</button>
        </div>
      </form>
    </dialog>
  );
}
