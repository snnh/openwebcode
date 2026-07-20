import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ModelProfile, PermissionMode, PricingDocument, SettingsField, SettingValue } from "../lib/contracts";
import { formatCurrency } from "../lib/format";
import type { SendKey, SessionDefaults } from "../lib/prefs";
import type { ThemePreference, AccentPreference } from "../theme";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const ACCENT_OPTIONS: Array<{ value: AccentPreference; label: string; swatch: string }> = [
  { value: "teal", label: "青", swatch: "#0b7285" },
  { value: "violet", label: "紫", swatch: "#6c5ce7" },
  { value: "blue", label: "蓝", swatch: "#2563eb" },
  { value: "orange", label: "橙", swatch: "#e8590c" },
  { value: "rose", label: "玫红", swatch: "#e1235c" },
  { value: "green", label: "绿", swatch: "#2f9e44" },
];

type SettingsTab = "appearance" | "general" | "defaults" | "server" | "models" | "skills" | "pricing" | "info";

const TAB_META: Array<{ id: SettingsTab; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "general", label: "通用" },
  { id: "defaults", label: "会话默认" },
  { id: "server", label: "服务设置" },
  { id: "models", label: "模型目录" },
  { id: "skills", label: "技能" },
  { id: "pricing", label: "模型定价" },
  { id: "info", label: "服务信息" },
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
  // 添加条目表单
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ provider: "", model: "", currency: "CNY", input: "", output: "", cacheRead: "", cacheWrite: "" });

  const startEdit = (): void => {
    if (!pricing.data) return;
    setJson(JSON.stringify(pricing.data, null, 2));
    setError(undefined);
    setEditing(true);
  };

  const save = (document: PricingDocument): Promise<void> => {
    setSaving(true);
    setError(undefined);
    return api.saveModelPricing(document)
      .then(() => {
        setEditing(false);
        setAdding(false);
        void queryClient.invalidateQueries({ queryKey: ["model-pricing"] });
        void queryClient.invalidateQueries({ queryKey: ["models"] });
      })
      .catch((saveError: unknown) => { setError(saveError instanceof Error ? saveError.message : "保存失败"); throw saveError; })
      .finally(() => setSaving(false));
  };

  const saveJson = (): void => {
    let document: PricingDocument;
    try {
      document = JSON.parse(json) as PricingDocument;
    } catch {
      setError("JSON 解析失败，请检查格式。");
      return;
    }
    void save(document);
  };

  const addEntry = (): void => {
    if (!pricing.data) return;
    const model = form.model.trim();
    const provider = form.provider.trim();
    if (!model || !provider) {
      setError("模型 id 与 provider 必填");
      return;
    }
    // 价格字段：每百万 tokens 单价（元/美元），转 micro-units（×1000000）
    const toMicro = (value: string): string => {
      const trimmed = value.trim();
      if (!trimmed) return "";
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) throw new Error(`价格「${value}」无效`);
      return String(Math.round(num * 1_000_000));
    };
    let parsed: { input: string; output: string; cacheRead: string; cacheWrite: string };
    try {
      parsed = {
        input: toMicro(form.input),
        output: toMicro(form.output),
        cacheRead: toMicro(form.cacheRead),
        cacheWrite: toMicro(form.cacheWrite),
      };
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "价格格式错误");
      return;
    }
    const document: PricingDocument = {
      ...pricing.data,
      entries: [
        ...pricing.data.entries,
        {
          provider,
          model,
          currency: form.currency as "USD" | "CNY",
          input: parsed.input,
          output: parsed.output,
          cacheRead: parsed.cacheRead,
          cacheWrite: parsed.cacheWrite,
        },
      ],
    };
    void save(document).then(() => {
      setForm({ provider: "", model: "", currency: "CNY", input: "", output: "", cacheRead: "", cacheWrite: "" });
    });
  };

  const removeEntry = (index: number): void => {
    if (!pricing.data) return;
    const entry = pricing.data.entries[index];
    if (!entry) return;
    if (!window.confirm(`删除 ${entry.provider}/${entry.model} 的定价？`)) return;
    const document: PricingDocument = {
      ...pricing.data,
      entries: pricing.data.entries.filter((_, i) => i !== index),
    };
    void save(document);
  };

  if (pricing.isPending) return <p className="panel-empty">加载中…</p>;
  if (pricing.isError || !pricing.data) return <p className="panel-empty">无法加载定价目录。</p>;

  const document = pricing.data;
  return (
    <>
      <div className="pricing-head">
        <span className="settings-note">{document.entries.length} 条定价 · 每百万 tokens 单价 · 更新于 {new Date(document.updatedAt).toLocaleString()}</span>
        {!editing && !adding && <button className="btn small" onClick={() => setAdding(true)}>添加条目</button>}
        {!editing && <button className="btn small" onClick={startEdit}>编辑 JSON</button>}
      </div>
      {adding && (
        <div className="pricing-add-form">
          <h4>添加定价条目</h4>
          <p className="settings-note">价格为每百万 tokens 单价（元/美元），保存时自动转 micro-units。</p>
          <div className="catalog-form">
            <input value={form.provider} placeholder="provider" aria-label="provider" onChange={(e) => setForm((p) => ({ ...p, provider: e.target.value }))} spellCheck={false} />
            <input value={form.model} placeholder="模型 id" aria-label="模型 id" onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))} spellCheck={false} />
            <select value={form.currency} aria-label="币种" onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}>
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
            <input value={form.input} placeholder="输入单价" aria-label="输入单价" inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, input: e.target.value }))} />
            <input value={form.output} placeholder="输出单价" aria-label="输出单价" inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, output: e.target.value }))} />
            <input value={form.cacheRead} placeholder="缓存读（可空）" aria-label="缓存读" inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, cacheRead: e.target.value }))} />
            <input value={form.cacheWrite} placeholder="缓存写（可空）" aria-label="缓存写" inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, cacheWrite: e.target.value }))} />
          </div>
          <div className="dialog-actions">
            <button className="btn" disabled={saving} onClick={() => { setAdding(false); setError(undefined); }}>取消</button>
            <button className="btn primary" disabled={saving} onClick={addEntry}>{saving ? "保存中…" : "添加"}</button>
          </div>
        </div>
      )}
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
            <button className="btn primary" disabled={saving} onClick={saveJson}>{saving ? "保存中…" : "保存定价"}</button>
          </div>
        </>
      ) : (
        <>
          <table className="pricing-table">
            <thead>
              <tr><th>模型</th><th>Provider</th><th>币种</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th></th></tr>
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
                  <td><button className="badge badge-action" disabled={saving} onClick={() => removeEntry(index)}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <p className="settings-error">{error}</p>}
        </>
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
          {availableModels.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.id}</option>)}
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

const SOURCE_LABEL: Record<string, string> = { builtin: "内置", api: "API", manual: "手动" };

function ModelCatalogSection(): ReactElement {
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ id: "", provider: "", contextWindow: "" });

  const invalidate = (): void => void queryClient.invalidateQueries({ queryKey: ["models"] });

  const refresh = (): void => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    api.refreshModels()
      .then((report) => {
        invalidate();
        const base = `新增 ${report.added} 个 · API 目录共 ${report.total} 个`;
        if (report.errors.length > 0) setError(`${base}；部分失败：${report.errors.join("；")}`);
        else setNotice(base);
      })
      .catch((refreshError: unknown) => setError(refreshError instanceof Error ? refreshError.message : "刷新失败"))
      .finally(() => setBusy(false));
  };

  const addManual = (): void => {
    const id = form.id.trim();
    if (!id) {
      setError("模型 id 不能为空");
      return;
    }
    const contextWindow = form.contextWindow.trim() ? Number(form.contextWindow) : undefined;
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1)) {
      setError("上下文窗口必须是正整数");
      return;
    }
    setBusy(true);
    setError(undefined);
    api.saveModel(id, { ...(form.provider.trim() ? { provider: form.provider.trim() } : {}), ...(contextWindow ? { contextWindow } : {}) })
      .then(() => {
        setForm({ id: "", provider: "", contextWindow: "" });
        setNotice(`已保存手动模型 ${id}`);
        invalidate();
      })
      .catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : "保存失败"))
      .finally(() => setBusy(false));
  };

  const removeManual = (id: string): void => {
    setBusy(true);
    setError(undefined);
    api.deleteModel(id)
      .then(() => {
        setNotice(`已删除 ${id}`);
        invalidate();
      })
      .catch((removeError: unknown) => setError(removeError instanceof Error ? removeError.message : "删除失败"))
      .finally(() => setBusy(false));
  };

  if (models.isPending) return <p className="panel-empty">加载中…</p>;
  if (models.isError || !models.data) return <p className="panel-empty">无法加载模型目录。</p>;

  return (
    <>
      <p className="settings-note">从已配置凭据的 provider 拉取模型列表；未知模型按内置元数据库保守成档。手动条目永不被刷新覆盖。</p>
      <div className="dialog-actions catalog-actions">
        <button className="btn small" disabled={busy} onClick={refresh}>{busy ? "处理中…" : "刷新模型目录"}</button>
      </div>
      {notice && <p className="settings-note">{notice}</p>}
      {error && <p className="settings-error">{error}</p>}
      <table className="pricing-table catalog-table">
        <thead>
          <tr><th>模型</th><th>Provider</th><th>来源</th><th>上下文</th><th></th></tr>
        </thead>
        <tbody>
          {models.data.map((model) => (
            <tr key={model.id}>
              <td className="mono">{model.displayName ?? model.id}</td>
              <td>{model.provider}</td>
              <td><span className={`badge badge-source-${model.source ?? "builtin"}`}>{SOURCE_LABEL[model.source ?? "builtin"]}</span></td>
              <td className="mono">{model.contextWindow.toLocaleString()}</td>
              <td>{model.source === "manual" && <button className="badge badge-action" disabled={busy} onClick={() => removeManual(model.id)}>删除</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="catalog-form">
        <input
          value={form.id}
          placeholder="模型 id（如 gpt-4o）"
          onChange={(event) => setForm((prev) => ({ ...prev, id: event.target.value }))}
          aria-label="模型 id"
          spellCheck={false}
        />
        <input
          value={form.provider}
          placeholder="provider（新模型必填）"
          onChange={(event) => setForm((prev) => ({ ...prev, provider: event.target.value }))}
          aria-label="provider"
          spellCheck={false}
        />
        <input
          value={form.contextWindow}
          placeholder="上下文窗口（可选）"
          onChange={(event) => setForm((prev) => ({ ...prev, contextWindow: event.target.value }))}
          aria-label="上下文窗口"
          inputMode="numeric"
        />
        <button className="btn small" disabled={busy} onClick={addManual}>添加手动模型</button>
      </div>
    </>
  );
}

function SkillsSection(): ReactElement {
  const skills = useQuery({ queryKey: ["global-skills"], queryFn: api.globalSkills });
  if (skills.isPending) return <p className="panel-empty">加载中…</p>;
  if (skills.isError) return <p className="panel-empty">无法加载技能清单。</p>;
  return (
    <>
      <p className="settings-note">
        全局技能放在数据目录 skills/&lt;名称&gt;/SKILL.md，项目技能放在 &lt;工作目录&gt;/.owc/skills/ 下；
        对话中输入 / 可呼出技能补全，模型也可经 load_skill 工具按需加载。
      </p>
      {skills.data.skills.length === 0 ? (
        <p className="panel-empty">还没有全局技能。</p>
      ) : (
        <table className="pricing-table catalog-table">
          <thead>
            <tr><th>名称</th><th>描述</th><th>路径</th></tr>
          </thead>
          <tbody>
            {skills.data.skills.map((skill) => (
              <tr key={skill.name}>
                <td className="mono">/{skill.name}</td>
                <td>{skill.description}</td>
                <td className="mono">{skill.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function SettingsDialog({ open, preference, setPreference, accent, setAccent, sendKey, setSendKey, defaults, setDefaults, providers, models, onResetLayout, onClose }: {
  open: boolean;
  preference: ThemePreference;
  setPreference(value: ThemePreference): void;
  accent: AccentPreference;
  setAccent(value: AccentPreference): void;
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
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");

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
        <nav className="settings-nav" aria-label="设置分类">
          {TAB_META.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-tab${activeTab === tab.id ? " active" : ""}`}
              aria-current={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="settings-panel">
          {activeTab === "appearance" && (
            <section>
              <h3>主题</h3>
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
              <h3>强调色</h3>
              <div className="settings-row accent-row" role="radiogroup" aria-label="强调色">
                {ACCENT_OPTIONS.map((option) => (
                  <label key={option.value} className="accent-option">
                    <input
                      type="radio"
                      name="accent"
                      checked={accent === option.value}
                      onChange={() => setAccent(option.value)}
                    />
                    <span className="accent-swatch" style={{ background: option.swatch }} />
                    {option.label}
                  </label>
                ))}
              </div>
              <p className="settings-note">强调色影响按钮、链接、高亮等元素；浅色与深色模式各自适配。</p>
            </section>
          )}
          {activeTab === "general" && (
            <section>
              <h3>发送方式</h3>
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
              <h3>布局</h3>
              <p className="settings-note">会话栏宽度/折叠、底部面板高度与开合保存在本机。</p>
              <button className="btn small" onClick={onResetLayout}>重置布局为默认</button>
            </section>
          )}
          {activeTab === "defaults" && (
            <section>
              <h3>会话默认</h3>
              <p className="settings-note">新建会话时预填的取值，可在对话框中再改。</p>
              <DefaultsSection defaults={defaults} setDefaults={setDefaults} providers={providers} models={models} />
            </section>
          )}
          {activeTab === "server" && (
            <section>
              <h3>服务设置</h3>
              <ServerSettingsSection />
            </section>
          )}
          {activeTab === "models" && (
            <section>
              <h3>模型目录</h3>
              <ModelCatalogSection />
            </section>
          )}
          {activeTab === "skills" && (
            <section>
              <h3>技能</h3>
              <SkillsSection />
            </section>
          )}
          {activeTab === "pricing" && (
            <section>
              <h3>模型定价</h3>
              <PricingSection />
            </section>
          )}
          {activeTab === "info" && (
            <section>
              <h3>服务信息</h3>
              <ServerInfoSection providers={providers} models={models} />
            </section>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </dialog>
  );
}
