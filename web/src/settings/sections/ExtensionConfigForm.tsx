import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ExtensionInfo } from "../../lib/contracts";
import { useI18n } from "../../i18n";

/** configSchema（JSON Schema 子集）解析后的单个可渲染字段 */
export interface ExtensionConfigField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "object" | "record";
  title?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  /** type === "object"：一层嵌套属性组（如 content-lens 的 translate.*） */
  children?: ExtensionConfigField[];
}

/**
 * 从 ExtensionInfo.configSchema 解析可渲染字段；schema 缺失、结构不符或没有可识别属性时返回 null，
 * 调用方据此回退到原始 JSON 编辑。
 * 支持 string/number/integer/boolean 标量、enum 下拉、一层 object 嵌套组，
 * 以及 additionalProperties: { type: "string" } 的字符串字典（record，按「键=值」行编辑）。
 */
export function parseConfigSchema(schema: Record<string, unknown> | undefined): ExtensionConfigField[] | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const fields = parseProperties(properties as Record<string, unknown>);
  return fields.length > 0 ? fields : null;
}

function parseProperties(properties: Record<string, unknown>): ExtensionConfigField[] {
  const fields: ExtensionConfigField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const prop = raw as Record<string, unknown>;
    const field = parseField(key, prop);
    if (field) fields.push(field);
  }
  return fields;
}

function parseField(key: string, prop: Record<string, unknown>): ExtensionConfigField | null {
  let field: ExtensionConfigField | null = null;
  if (prop.type === "string" || prop.type === "number" || prop.type === "integer" || prop.type === "boolean") {
    field = { key, type: prop.type };
    if (prop.type === "number" || prop.type === "integer") {
      if (typeof prop.minimum === "number" && Number.isFinite(prop.minimum)) field.minimum = prop.minimum;
      if (typeof prop.maximum === "number" && Number.isFinite(prop.maximum)) field.maximum = prop.maximum;
    }
    if (prop.type === "string" && Array.isArray(prop.enum)) {
      const values = prop.enum.filter((value): value is string => typeof value === "string");
      if (values.length > 0) field.enum = values;
    }
  } else if (prop.type === "object") {
    // 字符串字典：{ type: "object", additionalProperties: { type: "string" } }
    const additional = prop.additionalProperties;
    if (additional && typeof additional === "object" && !Array.isArray(additional)
      && (additional as Record<string, unknown>).type === "string") {
      field = { key, type: "record" };
    } else if (prop.properties && typeof prop.properties === "object" && !Array.isArray(prop.properties)) {
      const children = parseProperties(prop.properties as Record<string, unknown>);
      if (children.length > 0) field = { key, type: "object", children };
    }
  }
  if (!field) return null;
  if (typeof prop.title === "string" && prop.title) field.title = prop.title;
  if (typeof prop.description === "string" && prop.description) field.description = prop.description;
  return field;
}

/** 字段值在 FormValues 中的路径键（嵌套组用点号连接，如 translate.mode） */
type FormValues = Record<string, string | boolean>;

function readPath(config: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = config;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 沿路径克隆中间对象后写入/删除，避免改动 extension.config 的子对象引用 */
function writePath(config: Record<string, unknown>, path: string[], value: unknown): void {
  let target = config;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const next = target[key];
    const clone = next && typeof next === "object" && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    target[key] = clone;
    target = clone;
  }
  const last = path[path.length - 1]!;
  if (value === undefined) delete target[last];
  else target[last] = value;
}

function recordToLines(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item === "string")
    .map(([name, item]) => `${name}=${item as string}`)
    .join("\n");
}

/** 「键=值」行文本 → 字符串字典；任一行缺 = 时返回 null（调用方报错中止保存） */
function linesToRecord(text: string): Record<string, string> | null {
  const record: Record<string, string> = {};
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    record[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return record;
}

function initialValues(fields: ExtensionConfigField[], config: Record<string, unknown>, parentPath: string[] = []): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const path = [...parentPath, field.key];
    if (field.type === "object") {
      Object.assign(values, initialValues(field.children ?? [], config, path));
      continue;
    }
    const raw = readPath(config, path);
    const id = path.join(".");
    if (field.type === "boolean") values[id] = raw === true;
    else if (field.type === "number" || field.type === "integer") values[id] = typeof raw === "number" ? String(raw) : "";
    else if (field.type === "record") values[id] = recordToLines(raw);
    else values[id] = typeof raw === "string" ? raw : "";
  }
  return values;
}

/**
 * 扩展类型化配置表单：按 configSchema 渲染 select/number/checkbox/字典编辑器，
 * 与原始 JSON 编辑保持相同的“保存配置”显式提交语义；未覆盖的既有键原样保留。
 * env-sim 的 persona 字段选项由 api.envSimPersonas() 动态提供（空值表示不模拟）。
 */
export function ExtensionConfigForm({ extension, fields, busy, onSave }: {
  extension: ExtensionInfo;
  fields: ExtensionConfigField[];
  busy: boolean;
  onSave(config: Record<string, unknown>): void;
}): ReactElement {
  const { t } = useI18n();
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, extension.config));
  const [error, setError] = useState<string>();
  const isEnvSim = extension.id === "env-sim";
  const personas = useQuery({
    queryKey: ["env-sim-personas"],
    queryFn: api.envSimPersonas,
    enabled: isEnvSim,
  });

  useEffect(() => setValues(initialValues(fields, extension.config)), [extension.config, extension.configSchema]); // eslint-disable-line react-hooks/exhaustive-deps

  const setValue = (key: string, value: string | boolean): void => setValues((previous) => ({ ...previous, [key]: value }));

  const save = (): void => {
    const config: Record<string, unknown> = { ...extension.config };
    const applyField = (field: ExtensionConfigField, parentPath: string[]): boolean => {
      const path = [...parentPath, field.key];
      if (field.type === "object") {
        return (field.children ?? []).every((child) => applyField(child, path));
      }
      const raw = values[path.join(".")];
      if (field.type === "boolean") {
        writePath(config, path, raw === true);
      } else if (field.type === "number" || field.type === "integer") {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text === "") writePath(config, path, undefined);
        else {
          const parsed = Number(text);
          if (field.type === "integer" && !Number.isInteger(parsed)) {
            setError(t(`「${field.title ?? field.key}」必须是整数`, `"${field.title ?? field.key}" must be an integer`));
            return false;
          }
          if (Number.isFinite(parsed)) writePath(config, path, parsed);
        }
      } else if (field.type === "record") {
        const record = linesToRecord(typeof raw === "string" ? raw : "");
        if (!record) {
          setError(t(`「${field.title ?? field.key}」每行需为「键=值」格式`, `Each line of "${field.title ?? field.key}" must be "key=value"`));
          return false;
        }
        writePath(config, path, record);
      } else {
        writePath(config, path, typeof raw === "string" ? raw : "");
      }
      return true;
    };
    if (!fields.every((field) => applyField(field, []))) return;
    onSave(config);
  };

  const renderField = (field: ExtensionConfigField, parentPath: string[] = []): ReactElement => {
    const path = [...parentPath, field.key];
    const id = path.join(".");
    const label = field.title ?? field.key;
    const description = field.description ? <p className="settings-note">{field.description}</p> : null;
    if (field.type === "object") {
      return (
        <div key={id} className="extension-config-group">
          <span className="extension-config-group-title">{label}</span>
          {description}
          {(field.children ?? []).map((child) => renderField(child, path))}
        </div>
      );
    }
    if (field.type === "boolean") {
      return (
        <div key={id} className="extension-config-field">
          <label className="extension-switch">
            <input type="checkbox" checked={values[id] === true} disabled={busy} onChange={(event) => setValue(id, event.target.checked)} />
            {label}
          </label>
          {description}
        </div>
      );
    }
    if (isEnvSim && id === "persona") {
      const list = personas.data?.personas ?? [];
      const builtin = list.filter((persona) => persona.builtin);
      const custom = list.filter((persona) => !persona.builtin);
      const selected = typeof values[id] === "string" ? values[id] as string : "";
      const selectedIsCustom = Boolean(selected) && custom.some((persona) => persona.id === selected);
      return (
        <div key={id} className="extension-config-field">
          <label>
            {label}
            <select className="input" value={selected} disabled={busy} onChange={(event) => setValue(id, event.target.value)}>
              <option value="">{t("（不模拟）", "(No simulation)")}</option>
              {builtin.length > 0 && (
                <optgroup label={t("内置", "Built-in")}>
                  {builtin.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
                </optgroup>
              )}
              {custom.length > 0 && (
                <optgroup label={t("自定义", "Custom")}>
                  {custom.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
          {description}
          {selected && <PersonaPreview id={selected} />}
          {selectedIsCustom && <DeletePersonaButton id={selected} onDeleted={() => setValue(id, "")} />}
          <PersonaCreator onCreated={(personaId) => setValue(id, personaId)} />
          {personas.data && (
            <p className="settings-note">{t(
              `自定义预设从 ${personas.data.directory} 加载，可将共享的预设 .json 文件放入该目录。`,
              `User presets are loaded from ${personas.data.directory} — drop shared preset .json files there.`,
            )}</p>
          )}
        </div>
      );
    }
    if (field.type === "string" && field.enum) {
      const current = typeof values[id] === "string" ? values[id] as string : "";
      return (
        <div key={id} className="extension-config-field">
          <label>
            {label}
            <select className="input" value={current} disabled={busy} onChange={(event) => setValue(id, event.target.value)}>
              {!field.enum.includes(current) && <option value={current}>{current}</option>}
              {field.enum.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          {description}
        </div>
      );
    }
    if (field.type === "number" || field.type === "integer") {
      return (
        <div key={id} className="extension-config-field">
          <label>
            {label}
            <input
              className="input"
              type="number"
              value={typeof values[id] === "string" ? values[id] as string : ""}
              disabled={busy}
              onChange={(event) => setValue(id, event.target.value)}
              {...(field.type === "integer" ? { step: 1 } : {})}
              {...(field.minimum !== undefined ? { min: field.minimum } : {})}
              {...(field.maximum !== undefined ? { max: field.maximum } : {})}
            />
          </label>
          {description}
        </div>
      );
    }
    if (field.type === "record") {
      return (
        <div key={id} className="extension-config-field">
          <label>
            {label}
            <textarea
              className="input mono"
              rows={3}
              value={typeof values[id] === "string" ? values[id] as string : ""}
              disabled={busy}
              onChange={(event) => setValue(id, event.target.value)}
              spellCheck={false}
              placeholder={t("键=值，每行一条", "key=value, one per line")}
            />
          </label>
          {description}
        </div>
      );
    }
    return (
      <div key={id} className="extension-config-field">
        <label>
          {label}
          <input className="input" type="text" value={typeof values[id] === "string" ? values[id] as string : ""} disabled={busy} onChange={(event) => setValue(id, event.target.value)} spellCheck={false} />
        </label>
        {description}
      </div>
    );
  };

  return (
    <div className="extension-config-form">
      {fields.map((field) => renderField(field))}
      <div>
        <button className="btn small" disabled={busy} onClick={save}>{busy ? t("保存中…", "Saving…") : t("保存配置", "Save configuration")}</button>
      </div>
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}

/** env-sim 预设「选前预览」：身份行 + 工具形态摘要（别名/隐藏）+ 命令拟态，由详情端点供数。 */
function PersonaPreview({ id }: { id: string }): ReactElement | null {
  const { t } = useI18n();
  const detail = useQuery({
    queryKey: ["env-sim-persona", id],
    queryFn: () => api.envSimPersona(id),
  });
  if (!detail.data) return null;
  const persona = detail.data;
  const shapedCommands = [
    persona.initPrompt ? "/init" : "",
    persona.compactOverviewPrompt || persona.compactToolcallsPrompt ? "/compact" : "",
  ].filter(Boolean);
  return (
    <div className="persona-preview" data-testid="persona-preview">
      <p className="persona-preview-identity mono">{persona.identity}</p>
      <p className="settings-note">
        {persona.aliases.length > 0 && t(
          `工具形态：${persona.aliases.map((alias) => alias.as).join("、")}`,
          `Tool shapes: ${persona.aliases.map((alias) => alias.as).join(", ")}`,
        )}
        {persona.hideBuiltIns.length > 0 && ` · ${t(`隐藏 ${persona.hideBuiltIns.length} 个内置工具`, `${persona.hideBuiltIns.length} built-in tools hidden`)}`}
        {shapedCommands.length > 0 && ` · ${t(`命令拟态：${shapedCommands.join("、")}`, `Command shaping: ${shapedCommands.join(", ")}`)}`}
      </p>
    </div>
  );
}

/** env-sim 自定义预设删除按钮（两段确认）；删除成功后失效预设清单并回调。 */
function DeletePersonaButton({ id, onDeleted }: { id: string; onDeleted(): void }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteEnvSimPersona(id);
      await queryClient.invalidateQueries({ queryKey: ["env-sim-personas"] });
      await queryClient.invalidateQueries({ queryKey: ["env-sim-persona", id] });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="persona-preview">
      <button
        className={confirming ? "btn small danger" : "btn small"}
        disabled={busy}
        onClick={() => (confirming ? void remove() : setConfirming(true))}
      >
        {busy ? t("删除中…", "Deleting…") : confirming ? t("再次点击确认删除", "Click again to confirm") : t("删除此自定义预设", "Delete this preset")}
      </button>
      {confirming && !busy && (
        <button className="btn small" onClick={() => setConfirming(false)}>{t("取消", "Cancel")}</button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface PersonaDraft {
  id: string;
  name: string;
  identity: string;
  basePrompt: string;
  initPrompt: string;
  compactOverviewPrompt: string;
  compactToolcallsPrompt: string;
  aliasesText: string;
}

const EMPTY_DRAFT: PersonaDraft = {
  id: "",
  name: "",
  identity: "",
  basePrompt: "",
  initPrompt: "",
  compactOverviewPrompt: "",
  compactToolcallsPrompt: "",
  aliasesText: "[]",
};

/** env-sim「新建预设」表单：结构化字段 + aliases JSON 高级编辑（同 id 覆盖即编辑）。 */
function PersonaCreator({ onCreated }: { onCreated(id: string): void }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PersonaDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const setDraftField = (key: keyof PersonaDraft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [key]: event.target.value }));

  const save = async (): Promise<void> => {
    // 与 server preset-store 的 PRESET_ID_PATTERN 保持一致，提前拦截不必等 400
    const id = draft.id.trim();
    const name = draft.name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      setError(t("id 只能包含小写字母、数字、'-' 和 '_'，且以字母或数字开头", "ID may only contain lowercase letters, digits, '-' and '_', starting with a letter or digit"));
      return;
    }
    if (!name) {
      setError(t("名称不能为空", "Name is required"));
      return;
    }
    let aliases: unknown;
    try {
      aliases = JSON.parse(draft.aliasesText.trim() === "" ? "[]" : draft.aliasesText);
      if (!Array.isArray(aliases)) throw new Error("not an array");
    } catch {
      setError(t("aliases 不是合法的 JSON 数组", "Aliases must be a valid JSON array"));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const saved = await api.saveEnvSimPersona({
        id,
        name,
        identity: draft.identity,
        basePrompt: draft.basePrompt,
        aliases: aliases as Array<{ from: string; as: string; description?: string }>,
        ...(draft.initPrompt.trim() ? { initPrompt: draft.initPrompt } : {}),
        ...(draft.compactOverviewPrompt.trim() ? { compactOverviewPrompt: draft.compactOverviewPrompt } : {}),
        ...(draft.compactToolcallsPrompt.trim() ? { compactToolcallsPrompt: draft.compactToolcallsPrompt } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["env-sim-personas"] });
      onCreated(saved.id);
      setDraft(EMPTY_DRAFT);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className="persona-preview">
        <button className="btn small" onClick={() => setOpen(true)}>{t("新建预设", "New preset")}</button>
      </div>
    );
  }
  return (
    <div className="persona-preview" data-testid="persona-creator">
      <label className="settings-field">
        <span>{t("预设 id（小写字母/数字/-/_）", "Preset id (lowercase letters/digits/-/_)")}</span>
        <input className="input" type="text" value={draft.id} spellCheck={false} onChange={setDraftField("id")} placeholder="my-persona" />
      </label>
      <label className="settings-field">
        <span>{t("显示名称", "Display name")}</span>
        <input className="input" type="text" value={draft.name} onChange={setDraftField("name")} />
      </label>
      <label className="settings-field">
        <span>{t("身份行", "Identity line")}</span>
        <textarea className="input" rows={2} value={draft.identity} onChange={setDraftField("identity")} placeholder="You are ..." />
      </label>
      <label className="settings-field">
        <span>{t("基线提示词", "Base prompt")}</span>
        <textarea className="input" rows={5} value={draft.basePrompt} onChange={setDraftField("basePrompt")} />
      </label>
      <label className="settings-field">
        <span>{t("/init 提示词（可选）", "/init prompt (optional)")}</span>
        <textarea className="input" rows={3} value={draft.initPrompt} onChange={setDraftField("initPrompt")} />
      </label>
      <details>
        <summary>{t("高级：压缩提示词与工具形态", "Advanced: compaction prompts and tool shapes")}</summary>
        <label className="settings-field">
          <span>{t("压缩提示词（概览，可选）", "Compaction prompt (overview, optional)")}</span>
          <textarea className="input" rows={3} value={draft.compactOverviewPrompt} onChange={setDraftField("compactOverviewPrompt")} />
        </label>
        <label className="settings-field">
          <span>{t("压缩提示词（工具调用，可选）", "Compaction prompt (tool calls, optional)")}</span>
          <textarea className="input" rows={3} value={draft.compactToolcallsPrompt} onChange={setDraftField("compactToolcallsPrompt")} />
        </label>
        <label className="settings-field">
          <span>{t("aliases（JSON 数组）", "Aliases (JSON array)")}</span>
          <textarea rows={4} className="input mono" value={draft.aliasesText} spellCheck={false} onChange={setDraftField("aliasesText")} />
        </label>
      </details>
      <div className="dialog-actions">
        <button className="btn small primary" disabled={saving} onClick={() => void save()}>
          {saving ? t("保存中…", "Saving…") : t("保存预设", "Save preset")}
        </button>
        <button className="btn small" disabled={saving} onClick={() => { setOpen(false); setError(undefined); }}>{t("取消", "Cancel")}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
