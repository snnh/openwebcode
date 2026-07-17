import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ModelProfile, PermissionMode } from "../lib/contracts";
import type { SessionDefaults } from "../lib/prefs";

export interface NewSessionValues {
  cwd: string;
  title?: string;
  provider: string;
  model: string;
  permissionMode?: PermissionMode;
}

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

  if (!open) return null;

  const fallbackTitle = cwd.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";

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
          onCreate({ cwd: cwd.trim(), title: title.trim() || fallbackTitle || "新会话", provider, model, permissionMode });
        }}
      >
        <h2>新建会话</h2>
        <label>
          工作目录
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
            {dialogModels.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
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
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={!cwd.trim() || !model}>创建</button>
        </div>
      </form>
    </dialog>
  );
}
