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
  agentMode?: "plan" | "build";
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  setupScript?: string;
  workspaceMode?: "managed";
}

const SANDBOX_MODE_LABELS: Record<SandboxMode, [string, string]> = {
  appcontainer: ["应用容器（AppContainer，默认）", "AppContainer (default)"],
  wsb: ["Windows Sandbox（不可信代码）", "Windows Sandbox (untrusted code)"],
  jobobject: ["兼容模式（Job Object）", "Compatibility (Job Object)"],
  off: ["关闭沙盒", "Sandbox off"],
};

export function NewSessionDialog({ open, providers, models, defaults, busy = false, onClose, onCreate }: {
  open: boolean;
  providers: string[];
  models: ModelProfile[];
  defaults?: SessionDefaults;
  busy?: boolean;
  onClose(): void;
  onCreate(values: NewSessionValues): void;
}): ReactElement | null {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("appcontainer");
  const [setupScript, setSetupScript] = useState("");
  const [sandboxCaps, setSandboxCaps] = useState<SandboxCapabilities | undefined>();
  const [workspaceMode, setWorkspaceMode] = useState<"direct" | "managed">("direct");
  const [agentMode, setAgentMode] = useState<"plan" | "build">("build");
  const [managedCaps, setManagedCaps] = useState<ManagedWorkspaceCapability | undefined>();

  const availableModels = models.filter((item) => item.provider === provider);
  const dialogModels = availableModels;
  const selectedModel = dialogModels.find((item) => item.id === model);

  useEffect(() => {
    if (!open) return;
    // 应用设置里的会话默认值（provider 有效才预填）
    if (!provider || !providers.includes(provider)) {
      const preset = defaults?.provider && providers.includes(defaults.provider)
        ? defaults.provider
        : providers[0];
      setProvider(preset ?? "");
      setModel("");
    }
    if (defaults?.permissionMode) setPermissionMode(defaults.permissionMode);
  }, [open, provider, providers, defaults]);

  useEffect(() => {
    if (!open) return;
    setModel((value) => {
      // 设置里的默认模型在当前 provider 下可用时优先
      if (defaults?.model && dialogModels.some((item) => item.id === defaults.model && value === "")) {
        return defaults.model;
      }
      return dialogModels.some((item) => item.id === value) ? value : (dialogModels[0]?.id ?? "");
    });
    // dialogModels 随 provider 变化而重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider, models]);

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
            // appcontainer 是缺省，不必显式提交；setupScript 仅 wsb 有意义
            ...(sandboxMode !== "appcontainer" ? { sandboxMode } : {}),
            ...(sandboxMode === "wsb" && setupScript.trim() ? { setupScript: setupScript.trim() } : {}),
            ...(workspaceMode === "managed" ? { workspaceMode } : {}),
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
          <p className="dialog-hint">{t("还没有可用的 Provider，请先在 设置 → 服务设置 配置 Provider 和 API Key", "No providers are available. Configure a provider and API key under Settings → Server first.")}</p>
        )}
        <label>
          Provider
          <select value={provider} disabled={noProviders} onChange={(event) => setProvider(event.target.value)}>
            {providers.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label>
          {t("模型", "Model")}
          <select value={model} disabled={noProviders || noModels} onChange={(event) => setModel(event.target.value)}>
            {noModels && <option value="">{t("暂无可用模型", "No model available")}</option>}
            {dialogModels.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.id}</option>)}
          </select>
        </label>
        {selectedModel && (
          <div className="model-capability-summary" aria-label={t("所选模型能力", "Selected model capabilities")}>
            <span className="model-capability-summary-label">{t("能力", "Capabilities")}</span>
            <ModelCapabilityBadges capabilities={selectedModel.capabilities} />
          </div>
        )}
        {noModels && (
          <p className="dialog-hint">{t("该 Provider 尚无可用模型。请在 设置 → 模型目录 刷新模型列表，或添加手动模型后再创建会话。", "This provider has no available models. Refresh the model catalog or add a manual model under Settings → Models before creating a session.")}</p>
        )}
        <label>
          {t("模式", "Mode")}
          <select value={agentMode} onChange={(event) => setAgentMode(event.target.value as "plan" | "build")}>
            <option value="build">{t("构建模式（Build）", "Build")}</option>
            <option value="plan">{t("计划模式（Plan）", "Plan")}</option>
          </select>
        </label>
        <label>
          {t("权限模式", "Permission mode")}
          <select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}>
            <option value="ask">{t("每次确认", "Ask every time")}</option>
            <option value="acceptEdits">{t("接受编辑", "Accept edits")}</option>
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
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>{t("取消", "Cancel")}</button>
          <button type="submit" className="btn primary" disabled={busy || noProviders || noModels || !cwd.trim() || !model}>{busy ? t("创建中…", "Creating…") : t("创建", "Create")}</button>
        </div>
      </form>
    </dialog>
  );
}
