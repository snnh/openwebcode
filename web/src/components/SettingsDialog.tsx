import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ModelProfile, PermissionMode, PricingDocument, SettingsField, SettingValue } from "../lib/contracts";
import { formatCurrency } from "../lib/format";
import type { SendKey, SessionDefaults } from "../lib/prefs";
import type { ThemePreference } from "../theme";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const PERMISSION_OPTIONS: Array<{ value: PermissionMode | ""; label: string }> = [
  { value: "", label: "不预设" },
  { value: "ask", label: "每次确认" },
  { value: "acceptEdits", label: "接受编辑" },
  { value: "yolo", label: "YOLO" },
];

function PricingSection(): ReactElement {
  const queryClient = useQueryClient();
  const pricing = useQuery({ queryKey: ["model-pricing"], queryFn: api.modelPricing });
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const startEdit = (): void => {
    if (!pricing.data) return;
    setJson(JSON.stringify(pricing.data, null, 2));
    setError(undefined);
    setEditing(true);
  };

  const save = (): void => {
    let document: PricingDocument;
    try {
      document = JSON.parse(json) as PricingDocument;
    } catch {
      setError("JSON 解析失败，请检查格式。");
      return;
    }
    setSaving(true);
    setError(undefined);
    api.saveModelPricing(document)
      .then(() => {
        setEditing(false);
        void queryClient.invalidateQueries({ queryKey: ["model-pricing"] });
        void queryClient.invalidateQueries({ queryKey: ["models"] });
      })
      .catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : "保存失败"))
      .finally(() => setSaving(false));
  };

  if (pricing.isPending) return <p className="panel-empty">加载中…</p>;
  if (pricing.isError || !pricing.data) return <p className="panel-empty">无法加载定价目录。</p>;

  const document = pricing.data;
  return (
    <>
      <div className="pricing-head">
        <span className="settings-note">{document.entries.length} 条定价 · 每百万 tokens 单价 · 更新于 {new Date(document.updatedAt).toLocaleString()}</span>
        {!editing && <button className="btn small" onClick={startEdit}>编辑 JSON</button>}
      </div>
      {editing ? (
        <>
          <textarea
            className="pricing-editor mono"
            value={json}
            onChange={(event) => setJson(event.target.value)}
            aria-label="定价目录 JSON"
            spellCheck={false}
          />
          {error && <p className="settings-error">{error}</p>}
          <div className="dialog-actions">
            <button className="btn" disabled={saving} onClick={() => setEditing(false)}>取消</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存定价"}</button>
          </div>
        </>
      ) : (
        <table className="pricing-table">
          <thead>
            <tr><th>模型</th><th>Provider</th><th>币种</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th></tr>
          </thead>
          <tbody>
            {document.entries.map((entry, index) => (
              <tr key={`${entry.provider}/${entry.model}/${index}`}>
                <td className="mono">{entry.model}</td>
                <td>{entry.provider}</td>
                <td>{entry.currency}</td>
                <td className="mono">{entry.input ? formatCurrency(entry.input, entry.currency) : "—"}</td>
                <td className="mono">{entry.output ? formatCurrency(entry.output, entry.currency) : "—"}</td>
                <td className="mono">{entry.cacheRead ? formatCurrency(entry.cacheRead, entry.currency) : "—"}</td>
                <td className="mono">{entry.cacheWrite ? formatCurrency(entry.cacheWrite, entry.currency) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function DefaultsSection({ defaults, setDefaults, providers, models }: {
  defaults: SessionDefaults;
  setDefaults(value: SessionDefaults): void;
  providers: string[];
  models: ModelProfile[];
}): ReactElement {
  const provider = defaults.provider ?? "";
  const availableModels = models.filter((item) => item.provider === provider);
  return (
    <div className="settings-grid">
      <label>
        默认 Provider
        <select
          value={provider}
          onChange={(event) => {
            const next = event.target.value || undefined;
            setDefaults({ ...defaults, provider: next, model: undefined });
          }}
        >
          <option value="">不预设</option>
          {providers.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <label>
        默认模型
        <select
          value={defaults.model ?? ""}
          disabled={!provider || availableModels.length === 0}
          onChange={(event) => setDefaults({ ...defaults, model: event.target.value || undefined })}
        >
          <option value="">不预设</option>
          {availableModels.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select>
      </label>
      <label>
        默认权限模式
        <select
          value={defaults.permissionMode ?? ""}
          onChange={(event) => setDefaults({ ...defaults, permissionMode: (event.target.value || undefined) as PermissionMode | undefined })}
        >
          {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </div>
  );
}

function ServerInfoSection({ providers, models }: {
  providers: string[];
  models: ModelProfile[];
}): ReactElement {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15_000 });
  return (
    <dl className="server-info">
      <dt>API 状态</dt>
      <dd>{health.data?.status === "ok" ? "在线" : health.isError ? "不可达" : "检查中…"}</dd>
      <dt>Providers</dt>
      <dd>{providers.length > 0 ? providers.join("、") : "—"}</dd>
      <dt>模型档案</dt>
      <dd>{models.length} 个</dd>
    </dl>
  );
}

function ServerSettingsSection(): ReactElement {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [draft, setDraft] = useState<Record<string, string | boolean | null>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  if (settings.isPending) return <p className="panel-empty">加载中…</p>;
  if (settings.isError || !settings.data) return <p className="panel-empty">无法加载服务设置。</p>;

  const fields = new Map(settings.data.groups.flatMap((group) => group.fields.map((field) => [field.key, field] as const)));
  const dirty = Object.keys(draft).length > 0;

  const setField = (key: string, value: string | boolean | null): void => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError(undefined);
  };
  const resetField = (key: string): void => {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const save = (): void => {
    const overrides: Record<string, SettingValue | null> = {};
    for (const [key, value] of Object.entries(draft)) {
      const field = fields.get(key);
      if (!field) continue;
      if (value === null) {
        overrides[key] = null;
        continue;
      }
      if (field.type === "secret" && value === "") continue;
      if (field.type === "number") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          setError(`${field.label} 必须是正整数`);
          return;
        }
        overrides[key] = parsed;
      } else if (field.type === "boolean") {
        overrides[key] = value === true;
      } else if (value === "") {
        if (field.nullable) overrides[key] = null;
        else {
          setError(`${field.label} 不能为空`);
          return;
        }
      } else {
        overrides[key] = value;
      }
    }
    setSaving(true);
    setError(undefined);
    api.saveSettings(overrides)
      .then((view) => {
        queryClient.setQueryData(["settings"], view);
        setDraft({});
        void queryClient.invalidateQueries({ queryKey: ["providers"] });
        void queryClient.invalidateQueries({ queryKey: ["health"] });
      })
      .catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : "保存失败"))
      .finally(() => setSaving(false));
  };

  const renderInput = (field: SettingsField): ReactElement => {
    const pending = draft[field.key];
    const resetting = pending === null;
    const disabled = !field.editable || resetting;
    if (field.type === "boolean") {
      const checked = typeof pending === "boolean" ? pending : field.value === true;
      return (
        <label className="theme-option">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => setField(field.key, event.target.checked)}
          />
          {checked ? "开启" : "关闭"}
        </label>
      );
    }
    if (field.type === "select") {
      const value = typeof pending === "string" ? pending : String(field.value ?? "");
      return (
        <select value={value} disabled={disabled} onChange={(event) => setField(field.key, event.target.value)} aria-label={field.label}>
          {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      );
    }
    if (field.type === "secret") {
      const value = typeof pending === "string" ? pending : "";
      return (
        <input
          type="password"
          value={resetting ? "" : value}
          placeholder={resetting ? "保存后清除" : field.hasValue ? `当前：${field.masked ?? "已设置"}` : "未设置"}
          disabled={disabled}
          onChange={(event) => setField(field.key, event.target.value)}
          aria-label={field.label}
          autoComplete="off"
        />
      );
    }
    const value = typeof pending === "string" ? pending : String(field.value ?? "");
    return (
      <input
        type={field.type === "number" ? "number" : "text"}
        value={resetting ? "" : value}
        placeholder={resetting ? "保存后重置为默认" : field.nullable ? "未设置" : undefined}
        disabled={disabled}
        onChange={(event) => setField(field.key, event.target.value)}
        aria-label={field.label}
        spellCheck={false}
      />
    );
  };

  const renderField = (field: SettingsField): ReactElement => {
    const pending = draft[field.key];
    const resetting = pending === null;
    return (
      <div className="settings-field" key={field.key}>
        <div className="settings-field-head">
          <span>{field.label}</span>
          <span className="settings-badges">
            {field.source === "env" && <span className="badge badge-env">环境变量</span>}
            {field.source === "file" && <span className="badge badge-file">已覆盖</span>}
            {field.restartRequired && <span className="badge badge-restart">重启后生效</span>}
            {resetting && <span className="badge badge-dirty">将重置</span>}
            {!resetting && pending !== undefined && <span className="badge badge-dirty">未保存</span>}
            {resetting && (
              <button className="badge badge-action" onClick={() => resetField(field.key)}>撤销</button>
            )}
            {!resetting && field.editable && field.type === "secret" && field.hasValue && (
              <button className="badge badge-action" onClick={() => setField(field.key, null)}>清除</button>
            )}
            {!resetting && field.editable && field.type !== "secret" && field.source === "file" && (
              <button className="badge badge-action" onClick={() => setField(field.key, null)}>重置</button>
            )}
          </span>
        </div>
        {renderInput(field)}
        {field.description && <p className="settings-note">{field.description}</p>}
        {!field.editable && <p className="settings-note">由环境变量控制，界面内不可修改</p>}
      </div>
    );
  };

  return (
    <>
      <p className="settings-note">服务端全部配置项。密钥仅脱敏显示；保存的密钥以明文存放在本机数据目录。</p>
      {settings.data.groups.map((group) => (
        <div className="server-settings-group" key={group.id}>
          <h4>{group.label}</h4>
          {group.fields.map(renderField)}
        </div>
      ))}
      {error && <p className="settings-error">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" disabled={!dirty || saving} onClick={() => { setDraft({}); setError(undefined); }}>放弃更改</button>
        <button className="btn primary" disabled={!dirty || saving} onClick={save}>{saving ? "保存中…" : "保存服务设置"}</button>
      </div>
    </>
  );
}

export function SettingsDialog({ open, preference, setPreference, sendKey, setSendKey, defaults, setDefaults, providers, models, onResetLayout, onClose }: {
  open: boolean;
  preference: ThemePreference;
  setPreference(value: ThemePreference): void;
  sendKey: SendKey;
  setSendKey(value: SendKey): void;
  defaults: SessionDefaults;
  setDefaults(value: SessionDefaults): void;
  providers: string[];
  models: ModelProfile[];
  onResetLayout(): void;
  onClose(): void;
}): ReactElement | null {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="session-dialog settings-dialog"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="settings-body">
        <h2>设置</h2>
        <section>
          <h3>外观</h3>
          <div className="settings-row" role="radiogroup" aria-label="主题">
            {THEME_OPTIONS.map((option) => (
              <label key={option.value} className="theme-option">
                <input
                  type="radio"
                  name="theme"
                  checked={preference === option.value}
                  onChange={() => setPreference(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </section>
        <section>
          <h3>通用</h3>
          <div className="settings-row" role="radiogroup" aria-label="发送方式">
            <label className="theme-option">
              <input type="radio" name="send-key" checked={sendKey === "enter"} onChange={() => setSendKey("enter")} />
              Enter 发送
            </label>
            <label className="theme-option">
              <input type="radio" name="send-key" checked={sendKey === "ctrl-enter"} onChange={() => setSendKey("ctrl-enter")} />
              Ctrl+Enter 发送
            </label>
          </div>
        </section>
        <section>
          <h3>会话默认</h3>
          <p className="settings-note">新建会话时预填的取值，可在对话框中再改。</p>
          <DefaultsSection defaults={defaults} setDefaults={setDefaults} providers={providers} models={models} />
        </section>
        <section>
          <h3>服务设置</h3>
          <ServerSettingsSection />
        </section>
        <section>
          <h3>布局</h3>
          <p className="settings-note">会话栏宽度/折叠、底部面板高度与开合保存在本机。</p>
          <button className="btn small" onClick={onResetLayout}>重置布局为默认</button>
        </section>
        <section>
          <h3>模型定价</h3>
          <PricingSection />
        </section>
        <section>
          <h3>服务信息</h3>
          <ServerInfoSection providers={providers} models={models} />
        </section>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </dialog>
  );
}
