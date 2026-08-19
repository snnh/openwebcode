import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ExtensionInfo } from "../../lib/contracts";
import { useI18n } from "../../i18n";
import { DeletePersonaButton, PersonaCreator, PersonaPreview } from "./env-sim-personas";

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
  /** schema 自定义关键字 `x-model-picker: true`：渲染模型选择下拉（已启用服务商中支持图片输入的模型）。 */
  modelPicker?: boolean;
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
  // 自定义关键字：模型选择器（选项由已启用服务商 × 模型目录动态提供，无法写死在 schema）
  if (prop["x-model-picker"] === true) field.modelPicker = true;
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
  const hasModelPicker = fields.some((field) => field.modelPicker === true);
  const personas = useQuery({
    queryKey: ["env-sim-personas"],
    queryFn: api.envSimPersonas,
    enabled: isEnvSim,
  });
  // 模型选择器（x-model-picker）：已启用服务商 × 模型目录中支持图片输入的模型；值编码 `provider/model`
  const modelCatalog = useQuery({
    queryKey: ["models"],
    queryFn: api.models,
    enabled: hasModelPicker,
  });
  const modelProviders = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
    enabled: hasModelPicker,
  });
  const visionModelOptions = useMemo(() => {
    if (!hasModelPicker) return [];
    const enabled = new Set(modelProviders.data ?? []);
    return (modelCatalog.data ?? [])
      .filter((model) => enabled.has(model.provider))
      .filter((model) => model.capabilities.modalities.includes("image"))
      .map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.id}【${model.provider}】` }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [hasModelPicker, modelCatalog.data, modelProviders.data]);

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
    if (field.modelPicker) {
      const current = typeof values[id] === "string" ? values[id] as string : "";
      return (
        <div key={id} className="extension-config-field">
          <label>
            {label}
            <select className="input" value={current} disabled={busy} onChange={(event) => setValue(id, event.target.value)}>
              <option value="">{t("（未选择）", "(Not selected)")}</option>
              {visionModelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {description}
          {visionModelOptions.length === 0 && (
            <p className="settings-note">{t("没有可用的视觉模型：请先在「模型服务商」中启用支持图片输入的模型。", "No vision-capable models available: enable a model provider with image input first.")}</p>
          )}
        </div>
      );
    }
    if (isEnvSim && id === "persona") {      const list = personas.data?.personas ?? [];
      const builtin = list.filter((persona) => persona.builtin);
      const custom = list.filter((persona) => !persona.builtin);
      const selected = typeof values[id] === "string" ? values[id] as string : "";
      const selectedIsCustom = Boolean(selected) && custom.some((persona) => persona.id === selected);
      // 内置 id 且存在用户覆盖：显示「还原内置」（删除覆盖文件即还原）
      const selectedOverridden = Boolean(selected) && builtin.some((persona) => persona.id === selected && persona.overridden === true);
      return (
        <div key={id} className="extension-config-field">
          <label>
            {label}
            <select className="input" value={selected} disabled={busy} onChange={(event) => setValue(id, event.target.value)}>
              <option value="">{t("（不模拟）", "(No simulation)")}</option>
              {builtin.length > 0 && (
                <optgroup label={t("内置", "Built-in")}>
                  {builtin.map((persona) => <option key={persona.id} value={persona.id}>{persona.overridden === true ? t(`${persona.name}（已自定义）`, `${persona.name} (customized)`) : persona.name}</option>)}
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
          {selectedOverridden && <DeletePersonaButton id={selected} overridden onDeleted={() => undefined} />}
          <PersonaCreator onCreated={(personaId) => setValue(id, personaId)} />
          {personas.data && (
            <p className="settings-note">{t(
              `自定义预设从 ${personas.data.directory} 加载，可将共享的预设 .json 文件放入该目录；id 与内置预设相同时即自定义该内置（只覆盖填写的字段，其余继承内置）。`,
              `User presets are loaded from ${personas.data.directory} — drop shared preset .json files there; using a built-in id customizes that built-in (only the fields you provide take effect, the rest are inherited).`,
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