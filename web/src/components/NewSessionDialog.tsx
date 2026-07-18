import { useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import type { ManagedWorkspaceCapability, ModelProfile, PermissionMode, SandboxCapabilities, SandboxMode } from "../lib/contracts";
import type { SessionDefaults } from "../lib/prefs";

export interface NewSessionValues {
  cwd: string;
  title?: string;
  provider: string;
  model: string;
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  setupScript?: string;
  workspaceMode?: "managed";
}

const SANDBOX_MODE_LABELS: Record<SandboxMode, string> = {
  appcontainer: "应用容器（AppContainer，默认）",
  wsb: "Windows Sandbox（不可信代码）",
  jobobject: "兼容模式（Job Object）",
  off: "关闭沙盒",
};

export function NewSessionDialog({ open, providers, models, defaults, onClose, onCreate }: {
  open: boolean;
  providers: string[];
  models: ModelProfile[];
  defaults?: SessionDefaults;
  onClose(): void;
  onCreate(values: NewSessionValues): void;
}): ReactElement | null {
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
  const [managedCaps, setManagedCaps] = useState<ManagedWorkspaceCapability | undefined>();

  const availableModels = models.filter((item) => item.provider === provider);
  // provider 无模型档案（如 development）时提供占位项，服务端对未知模型有 fallback profile
  const dialogModels = availableModels.length > 0
    ? availableModels
    : [{ id: "default", displayName: "默认模型" } as ModelProfile];

  useEffect(() => {
    if (!open) return;
    // 应用设置里的会话默认值（provider 有效才预填）
    if (!provider) {
      const preset = defaults?.provider && providers.includes(defaults.provider)
        ? defaults.provider
        : providers[0];
      if (preset) setProvider(preset);
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
  const managedAvailable = managedCaps?.backends.some((item) => item.available) ?? false;
  const managedUnavailableReason = managedCaps === undefined
    ? "能力检测中…"
    : managedCaps.backends.map((item) => item.detail).filter(Boolean).join("；") || "当前平台不支持托管工作区";

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
          if (!cwd.trim() || !model) return;
          onCreate({
            cwd: cwd.trim(),
            title: title.trim() || fallbackTitle || "新会话",
            provider,
            model,
            permissionMode,
            // appcontainer 是缺省，不必显式提交；setupScript 仅 wsb 有意义
            ...(sandboxMode !== "appcontainer" ? { sandboxMode } : {}),
            ...(sandboxMode === "wsb" && setupScript.trim() ? { setupScript: setupScript.trim() } : {}),
            ...(workspaceMode === "managed" ? { workspaceMode } : {}),
          });
        }}
      >
        <h2>新建会话</h2>
        <label>
          工作区模式
          <select value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as "direct" | "managed")}>
            <option value="direct">直接（默认）</option>
            <option value="managed" disabled={!managedAvailable} title={managedAvailable ? undefined : managedUnavailableReason}>
              托管工作区（镜像盘隔离）
            </option>
          </select>
        </label>
        {managedCaps && !managedAvailable && (
          <p className="dialog-hint">托管工作区不可用：{managedUnavailableReason}</p>
        )}
        {workspaceMode === "managed" && (
          <p className="dialog-hint">
            将创建 20GB 稀疏镜像盘并挂载到数据根 mnt/ 目录，源目录内容（排除 node_modules 等）会复制进去；需要管理员（Hyper-V）或 root（qemu-nbd）权限。
          </p>
        )}
        <label>
          {workspaceMode === "managed" ? "源目录（将复制进托管工作区）" : "工作目录"}
          <input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="绝对路径，如 D:\projects\demo 或 /home/me/demo"
            required
            autoFocus
          />
        </label>
        <label>
          标题（可选）
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={fallbackTitle || "默认为目录名"}
          />
        </label>
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            {providers.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label>
          模型
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            {dialogModels.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.id}</option>)}
          </select>
        </label>
        <label>
          权限模式
          <select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}>
            <option value="ask">每次确认</option>
            <option value="acceptEdits">接受编辑</option>
            <option value="yolo">YOLO</option>
          </select>
        </label>
        <label>
          沙盒模式
          <select value={sandboxMode} onChange={(event) => setSandboxMode(event.target.value as SandboxMode)}>
            {(Object.keys(SANDBOX_MODE_LABELS) as SandboxMode[]).map((mode) => (
              <option key={mode} value={mode} disabled={mode === "wsb" && sandboxCaps !== undefined && !sandboxCaps.wsb.available}>
                {SANDBOX_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        {sandboxCaps && !sandboxCaps.wsb.available && (
          <p className="dialog-hint">Windows Sandbox 不可用：{sandboxCaps.wsb.reason ?? "未启用可选功能"}</p>
        )}
        {sandboxMode === "wsb" && (
          <label>
            初始化脚本（可选）
            <input
              value={setupScript}
              onChange={(event) => setSetupScript(event.target.value)}
              placeholder="沙盒启动后、agent 启动前执行的命令"
            />
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={!cwd.trim() || !model}>创建</button>
        </div>
      </form>
    </dialog>
  );
}
