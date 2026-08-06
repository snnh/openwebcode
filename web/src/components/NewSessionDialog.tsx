import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ManagedWorkspaceCapability, ModelProfile, PermissionMode, SandboxMode, SandboxNetwork } from "../lib/contracts";
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
  network?: SandboxNetwork;
  setupScript?: string;
  workspaceMode?: "managed";
  bindLinks?: { virtPath: string; backingPath: string; readOnly?: boolean }[];
  /** 会话级工具限制：逗号分隔的内置工具名（留空 = 不限制）。 */
  toolsAllow?: string[];
  toolsDeny?: string[];
  /** 备选模型链（最多 3 条 provider/model；留空不提交）。 */
  fallbackModels?: { provider: string; model: string }[];
}

const SANDBOX_MODE_LABELS: Record<SandboxMode, [string, string]> = {
  appcontainer: ["应用容器（AppContainer）", "AppContainer"],
  wsb: ["Windows Sandbox（不可信代码）", "Windows Sandbox (untrusted code)"],
  jobobject: ["兼容模式（Job Object，默认）", "Compatibility (Job Object, default)"],
  landlock: ["强制模式（Landlock，默认）", "Enforced (Landlock, default)"],
  bubblewrap: ["隔离模式（bubblewrap）", "Isolated (bubblewrap)"],
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
  const [network, setNetwork] = useState<SandboxNetwork>("allow");
  const [setupScript, setSetupScript] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<"direct" | "managed">("direct");
  const [agentMode, setAgentMode] = useState<"plan" | "code" | "goal">("code");
  const [managedCaps, setManagedCaps] = useState<ManagedWorkspaceCapability | undefined>();
  const [bindLinks, setBindLinks] = useState<{ virtPath: string; backingPath: string; readOnly: boolean }[]>([]);
  const [toolsAllow, setToolsAllow] = useState("");
  const [toolsDeny, setToolsDeny] = useState("");
  const [fallbacks, setFallbacks] = useState<{ provider: string; model: string }[]>([]);

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

  // 沙盒能力走 React Query（与 JobHeader 共用 ["sandbox-capabilities"] 缓存）；失败按不可用处理
  const sandboxCapsQuery = useQuery({
    queryKey: ["sandbox-capabilities"],
    queryFn: api.sandboxCapabilities,
    staleTime: 60_000,
    enabled: open,
  });
  const sandboxCaps = sandboxCapsQuery.data;

  // 打开时拉取托管工作区能力；失败按不可用处理
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.managedWorkspaceCapability()
      .then((caps) => { if (!cancelled) setManagedCaps(caps); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  const bindLinkCap = sandboxCaps?.bindLink;
  const bindLinkAvailable = bindLinkCap?.available ?? false;
  // 平台来源统一为 server 上报的 capabilities.platform；未拿到前保持 Windows 行为（现状）
  const isWindows = sandboxCaps?.platform === undefined || sandboxCaps.platform === "win32";
  // POSIX 真值选项：landlock（默认档）/ bubblewrap / off；Windows 维持 appcontainer/jobobject/wsb/off
  const sandboxModeOptions: SandboxMode[] = isWindows
    ? ["appcontainer", "wsb", "jobobject", "off"]
    : ["landlock", "bubblewrap", "off"];
  // 内部缺省态 jobobject 在非 Windows 下按 landlock 显示（不提交即为 server 默认；显式选择才提交真值）
  const selectedSandboxMode: SandboxMode = !isWindows && sandboxMode === "jobobject" ? "landlock" : sandboxMode;
  // bubblewrap 不可用时禁用该选项（旧 core 不上报 features.bwrap 时 server 按 unavailable 返回）
  const bwrapUnavailableReason = !isWindows && sandboxCaps?.bwrap?.available === false
    ? sandboxCaps.bwrap.reason ?? t("当前环境未安装 bubblewrap", "bubblewrap is not available in this environment")
    : undefined;
  // 只提交两个路径都填了的行；未填完整的行静默忽略
  const validBindLinks = bindLinks
    .map((link) => ({ virtPath: link.virtPath.trim(), backingPath: link.backingPath.trim(), ...(link.readOnly ? { readOnly: true as const } : {}) }))
    .filter((link) => link.virtPath.length > 0 && link.backingPath.length > 0);
  // 工具限制输入：逗号分隔、逐项 trim、空项丢弃；留空 = 不限制（不提交字段）
  const parseToolList = (value: string): string[] => value.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  const parsedToolsAllow = parseToolList(toolsAllow);
  const parsedToolsDeny = parseToolList(toolsDeny);
  // 备选模型：剔除与主模型重复及彼此重复的行（服务端校验同款规则兜底）；留空 = 不提交
  const parsedFallbacks = fallbacks
    .filter((entry) => entry.provider && entry.model && !(entry.provider === provider && entry.model === model))
    .filter((entry, index, all) => all.findIndex((other) => other.provider === entry.provider && other.model === entry.model) === index)
    .slice(0, 3);
  // 备选模型可选项：排除当前主模型
  const fallbackOptions = dialogModels.filter((item) => !(item.provider === provider && item.id === model));

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
            // jobobject 是缺省，不必显式提交；setupScript 仅 wsb 有意义；network 缺省 allow 不必提交
            ...(sandboxMode !== "jobobject" ? { sandboxMode } : {}),
            ...(network !== "allow" ? { network } : {}),
            ...(sandboxMode === "wsb" && setupScript.trim() ? { setupScript: setupScript.trim() } : {}),
            ...(workspaceMode === "managed" ? { workspaceMode } : {}),
            ...(validBindLinks.length ? { bindLinks: validBindLinks } : {}),
            ...(parsedToolsAllow.length ? { toolsAllow: parsedToolsAllow } : {}),
            ...(parsedToolsDeny.length ? { toolsDeny: parsedToolsDeny } : {}),
            ...(parsedFallbacks.length ? { fallbackModels: parsedFallbacks } : {}),
          });
        }}
      >
        <h2>{t("新建会话", "New session")}</h2>
        <label className="settings-field">
          <span>{t("工作区模式", "Workspace mode")}</span>
          <select className="input" value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as "direct" | "managed")}>
            <option value="direct">{t("直接（默认）", "Direct (default)")}</option>
            <option value="managed" disabled={!managedAvailable} title={managedAvailable ? undefined : managedUnavailableReason}>
              {t("托管工作区（镜像盘隔离）", "Managed workspace (disk-image isolation)")}
            </option>
          </select>
        </label>
        {managedCaps && !managedAvailable && (
          <p className="muted-empty dialog-hint">{t("托管工作区不可用：", "Managed workspace unavailable: ")}{managedUnavailableReason}</p>
        )}
        {workspaceMode === "managed" && (
          <p className="muted-empty dialog-hint">{t("将创建 20GB 稀疏镜像盘并挂载到数据根 mnt/ 目录，源目录内容（排除 node_modules 等）会复制进去；需要管理员（Hyper-V）或 root（qemu-nbd）权限。源目录不会在关闭或删除会话时自动覆盖；可在“文件”面板随时预览差异并确认同步回源。", "A 20 GB sparse disk image will be created and mounted under mnt/ in the data root. Source contents (excluding node_modules and similar paths) are copied into it. Administrator (Hyper-V) or root (qemu-nbd) access is required. Closing or deleting the session never overwrites the source directory automatically; use the Files panel to preview changes and explicitly sync them back at any time.")}</p>
        )}
        <label className="settings-field">
          <span>{workspaceMode === "managed" ? t("源目录（将复制进托管工作区）", "Source directory (copied into managed workspace)") : t("工作目录", "Working directory")}</span>
          <input
            className="input"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder={t("绝对路径，如 D:\\projects\\demo 或 /home/me/demo", "Absolute path, such as D:\\projects\\demo or /home/me/demo")}
            required
            autoFocus
          />
        </label>
        <label className="settings-field">
          <span>{t("标题（可选）", "Title (optional)")}</span>
          <input
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={fallbackTitle || t("默认为目录名", "Defaults to directory name")}
          />
        </label>
        {noProviders && (
          <p className="muted-empty dialog-hint">{t("还没有可用的 Provider，请先在 设置 → 模型目录 配置 Provider 和 API Key", "No providers are available. Configure a provider and API key under Settings → Models first.")}{onOpenSettings && <>{" "}<button type="button" className="dialog-hint-link" onClick={() => onOpenSettings("models")}>{t("前往配置 →", "Configure →")}</button></>}</p>
        )}
        <label className="settings-field">
          <span>{t("模型", "Model")}</span>
          <select className="input" value={selection} disabled={noProviders || noModels} onChange={(event) => {
            const next = dialogModels.find((item) => JSON.stringify([item.provider, item.id]) === event.target.value || item.id === event.target.value);
            if (next) {
              setProvider(next.provider);
              setModel(next.id);
            }
          }}>
            {noModels && <option value="">{t("暂无可用模型", "No model available")}</option>}
            {dialogModels.map((item) => {
              const value = JSON.stringify([item.provider, item.id]);
              return <option key={value} value={value}>{t(`${item.id}【${item.provider}】`, `${item.id} (${item.provider})`)}</option>;
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
          <p className="muted-empty dialog-hint">{t("已启用的服务商尚无可用模型。请在设置中刷新模型列表，或为服务商手动添加模型。", "Enabled providers have no models. Refresh the model catalog or add a manual model for a provider in Settings.")}{onOpenSettings && <>{" "}<button type="button" className="dialog-hint-link" onClick={() => onOpenSettings("models")}>{t("前往模型目录 →", "Open catalog →")}</button></>}</p>
        )}
        <div className="bindlink-editor">
          <div className="bindlink-editor-header">
            <span>{t("备选模型（可选）", "Fallback models (optional)")}</span>
            <button
              type="button"
              className="btn"
              disabled={fallbacks.length >= 3 || fallbackOptions.length === 0}
              onClick={() => {
                const first = fallbackOptions.find((item) => !fallbacks.some((entry) => entry.provider === item.provider && entry.model === item.id));
                if (first) setFallbacks([...fallbacks, { provider: first.provider, model: first.id }]);
              }}
            >
              {t("添加备选", "Add fallback")}
            </button>
          </div>
          {fallbacks.map((entry, index) => (
            <div className="bindlink-row" key={index}>
              <select
                className="input"
                value={JSON.stringify([entry.provider, entry.model])}
                aria-label={t("备选模型", "Fallback model")}
                onChange={(event) => {
                  const next = dialogModels.find((item) => JSON.stringify([item.provider, item.id]) === event.target.value);
                  if (next) setFallbacks(fallbacks.map((item, i) => (i === index ? { provider: next.provider, model: next.id } : item)));
                }}
              >
                {fallbackOptions.map((item) => {
                  const value = JSON.stringify([item.provider, item.id]);
                  return <option key={value} value={value}>{t(`${item.id}【${item.provider}】`, `${item.id} (${item.provider})`)}</option>;
                })}
              </select>
              <button type="button" className="btn" onClick={() => setFallbacks(fallbacks.filter((_, i) => i !== index))}>{t("移除", "Remove")}</button>
            </div>
          ))}
          {fallbacks.length > 0 && (
            <p className="muted-empty dialog-hint">{t("主模型因限流/过载等可恢复错误重试耗尽后，按顺序切换到备选模型继续本轮任务（最多 3 个，每个只尝试一次）。", "If the primary model exhausts retries on a recoverable error (rate limit / overload etc.), the run continues on the next fallback model (up to 3, each tried once).")}</p>
          )}
        </div>
        <label className="settings-field">
          <span>{t("模式", "Mode")}</span>
          <select className="input" value={agentMode} onChange={(event) => setAgentMode(event.target.value as "plan" | "code" | "goal")}>
            <option value="code">{t("代码模式（Code）", "Code")}</option>
            <option value="plan">{t("计划模式（Plan）", "Plan")}</option>
            <option value="goal">{t("目标模式（Goal）", "Goal")}</option>
          </select>
        </label>
        <label className="settings-field">
          <span>{t("权限模式", "Permission mode")}</span>
          <select className="input" value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}>
            <option value="ask">{t("每次确认", "Ask every time")}</option>
            <option value="acceptEdits">{t("接受编辑", "Accept edits")}</option>
            <option value="review">{t("模型审核", "Model review")}</option>
            <option value="yolo">YOLO</option>
          </select>
        </label>
        <label className="settings-field">
          <span>{t("沙盒模式", "Sandbox mode")}</span>
          <select className="input" value={selectedSandboxMode} onChange={(event) => setSandboxMode(event.target.value as SandboxMode)}>
            {sandboxModeOptions.map((mode) => (
              <option
                key={mode}
                value={mode}
                disabled={(mode === "wsb" && sandboxCaps !== undefined && !sandboxCaps.wsb.available) || (mode === "bubblewrap" && bwrapUnavailableReason !== undefined)}
                title={mode === "bubblewrap" ? bwrapUnavailableReason : undefined}
              >
                {t(...SANDBOX_MODE_LABELS[mode])}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span>{t("网络", "Network")}</span>
          <select className="input" value={network} onChange={(event) => setNetwork(event.target.value as SandboxNetwork)}>
            <option value="allow">{t("允许（默认）", "Allow (default)")}</option>
            <option value="deny">{t("拒绝", "Deny")}</option>
            {isWindows && <option value="filtered">{t("代理过滤（仅 Windows）", "Filtered via proxy (Windows only)")}</option>}
          </select>
        </label>
        {network === "filtered" && (
          <p className="muted-empty dialog-hint">{t("经代理过滤出网（仅 Windows）；Linux 会话不支持该策略。", "Outbound traffic is filtered via a proxy (Windows only); not supported on Linux sessions.")}</p>
        )}
        {isWindows && sandboxCaps && !sandboxCaps.wsb.available && (
          <p className="muted-empty dialog-hint">{t("Windows Sandbox 不可用：", "Windows Sandbox unavailable: ")}{sandboxCaps.wsb.reason ?? t("未启用可选功能", "optional feature is not enabled")}</p>
        )}
        {sandboxMode === "wsb" && (
          <label className="settings-field">
            <span>{t("初始化脚本（可选）", "Setup script (optional)")}</span>
            <input
              className="input"
              value={setupScript}
              onChange={(event) => setSetupScript(event.target.value)}
              placeholder={t("沙盒启动后、agent 启动前执行的命令", "Command to run after the sandbox starts and before the agent starts")}
            />
          </label>
        )}
        {isWindows && (sandboxMode === "jobobject" || sandboxMode === "appcontainer") && (
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
              <p className="muted-empty dialog-hint">{t("Bind Link 不可用：", "Bind Link unavailable: ")}{bindLinkCap.reason ?? t("当前平台 core 未提供 Bind Link 能力", "Bind Link capability is not available on this platform")}</p>
            )}
            {bindLinks.map((link, index) => (
              <div className="bindlink-row" key={index}>
                <input
                  className="input"
                  value={link.virtPath}
                  onChange={(event) => setBindLinks(bindLinks.map((item, i) => (i === index ? { ...item, virtPath: event.target.value } : item)))}
                  placeholder={t("沙盒内路径，如 C:\\mnt\\shared", "In-sandbox path, such as C:\\mnt\\shared")}
                  aria-label={t("沙盒内路径", "In-sandbox path")}
                />
                <input
                  className="input"
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
              <p className="muted-empty dialog-hint">{t("Bind Link 需要 Windows 11 24H2+ 且 server 以管理员权限运行；沙盒内路径是进程可见的挂载点，按只读/可写映射到宿主目录。", "Bind Link requires Windows 11 24H2+ and an elevated server; the in-sandbox path is the mount point processes see, mapped to the host directory with the chosen writability.")}</p>
            )}
          </div>
        )}
        <label className="settings-field">
          <span>{t("工具白名单（可选）", "Tool allowlist (optional)")}</span>
          <input
            className="input"
            value={toolsAllow}
            onChange={(event) => setToolsAllow(event.target.value)}
            placeholder={t("逗号分隔内置工具名，如 read_file,glob,grep；留空 = 不限制", "Comma-separated built-in tool names, e.g. read_file,glob,grep; empty = no limit")}
          />
        </label>
        <label className="settings-field">
          <span>{t("工具黑名单（可选）", "Tool denylist (optional)")}</span>
          <input
            className="input"
            value={toolsDeny}
            onChange={(event) => setToolsDeny(event.target.value)}
            placeholder={t("逗号分隔内置工具名，如 bash,write_file；在白名单结果上再剔除", "Comma-separated built-in tool names, e.g. bash,write_file; removed on top of the allowlist")}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>{t("取消", "Cancel")}</button>
          <button type="submit" className="btn primary" disabled={busy || noProviders || noModels || !cwd.trim() || !model}>{busy ? t("创建中…", "Creating…") : t("创建", "Create")}</button>
        </div>
      </form>
    </dialog>
  );
}
