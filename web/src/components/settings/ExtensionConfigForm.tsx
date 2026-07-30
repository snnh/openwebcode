import { useEffect, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ExtensionInfo } from "../../lib/contracts";
import { useI18n } from "../../i18n";

/** configSchema（JSON Schema 子集）解析后的单个可渲染字段 */
export interface ExtensionConfigField {
  key: string;
  type: "string" | "number" | "boolean";
  title?: string;
  description?: string;
  enum?: string[];
}

/**
 * 从 ExtensionInfo.configSchema 解析可渲染字段；schema 缺失、结构不符或没有可识别属性时返回 null，
 * 调用方据此回退到原始 JSON 编辑。
 */
export function parseConfigSchema(schema: Record<string, unknown> | undefined): ExtensionConfigField[] | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const fields: ExtensionConfigField[] = [];
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const prop = raw as Record<string, unknown>;
    if (prop.type !== "string" && prop.type !== "number" && prop.type !== "boolean") continue;
    const field: ExtensionConfigField = { key, type: prop.type };
    if (typeof prop.title === "string" && prop.title) field.title = prop.title;
    if (typeof prop.description === "string" && prop.description) field.description = prop.description;
    if (Array.isArray(prop.enum)) {
      const values = prop.enum.filter((value): value is string => typeof value === "string");
      if (values.length > 0) field.enum = values;
    }
    fields.push(field);
  }
  return fields.length > 0 ? fields : null;
}

type FormValues = Record<string, string | boolean>;

function initialValues(fields: ExtensionConfigField[], config: Record<string, unknown>): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const raw = config[field.key];
    if (field.type === "boolean") values[field.key] = raw === true;
    else if (field.type === "number") values[field.key] = typeof raw === "number" ? String(raw) : "";
    else values[field.key] = typeof raw === "string" ? raw : "";
  }
  return values;
}

/**
 * 扩展类型化配置表单：按 configSchema 渲染 select/number/checkbox，
 * 与原始 JSON 编辑保持相同的“保存配置”显式提交语义。
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
    for (const field of fields) {
      const raw = values[field.key];
      if (field.type === "boolean") {
        config[field.key] = raw === true;
      } else if (field.type === "number") {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text === "") delete config[field.key];
        else {
          const parsed = Number(text);
          if (Number.isFinite(parsed)) config[field.key] = parsed;
        }
      } else {
        config[field.key] = typeof raw === "string" ? raw : "";
      }
    }
    onSave(config);
  };

  const renderField = (field: ExtensionConfigField): ReactElement => {
    const label = field.title ?? field.key;
    const description = field.description ? <p className="settings-note">{field.description}</p> : null;
    if (field.type === "boolean") {
      return (
        <div key={field.key} className="extension-config-field">
          <label className="extension-switch">
            <input type="checkbox" checked={values[field.key] === true} disabled={busy} onChange={(event) => setValue(field.key, event.target.checked)} />
            {label}
          </label>
          {description}
        </div>
      );
    }
    if (isEnvSim && field.key === "persona") {
      const list = personas.data?.personas ?? [];
      const builtin = list.filter((persona) => persona.builtin);
      const custom = list.filter((persona) => !persona.builtin);
      const selected = typeof values[field.key] === "string" ? values[field.key] as string : "";
      return (
        <div key={field.key} className="extension-config-field">
          <label>
            {label}
            <select value={selected} disabled={busy} onChange={(event) => setValue(field.key, event.target.value)}>
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
      const current = typeof values[field.key] === "string" ? values[field.key] as string : "";
      return (
        <div key={field.key} className="extension-config-field">
          <label>
            {label}
            <select value={current} disabled={busy} onChange={(event) => setValue(field.key, event.target.value)}>
              {!field.enum.includes(current) && <option value={current}>{current}</option>}
              {field.enum.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          {description}
        </div>
      );
    }
    if (field.type === "number") {
      return (
        <div key={field.key} className="extension-config-field">
          <label>
            {label}
            <input type="number" value={typeof values[field.key] === "string" ? values[field.key] as string : ""} disabled={busy} onChange={(event) => setValue(field.key, event.target.value)} />
          </label>
          {description}
        </div>
      );
    }
    return (
      <div key={field.key} className="extension-config-field">
        <label>
          {label}
          <input type="text" value={typeof values[field.key] === "string" ? values[field.key] as string : ""} disabled={busy} onChange={(event) => setValue(field.key, event.target.value)} spellCheck={false} />
        </label>
        {description}
      </div>
    );
  };

  return (
    <div className="extension-config-form">
      {fields.map(renderField)}
      <div>
        <button className="btn small" disabled={busy} onClick={save}>{busy ? t("保存中…", "Saving…") : t("保存配置", "Save configuration")}</button>
      </div>
    </div>
  );
}

/** env-sim 预设「选前预览」：身份行 + 工具形态摘要（别名/隐藏），由详情端点供数。 */
function PersonaPreview({ id }: { id: string }): ReactElement | null {
  const { t } = useI18n();
  const detail = useQuery({
    queryKey: ["env-sim-persona", id],
    queryFn: () => api.envSimPersona(id),
  });
  if (!detail.data) return null;
  const persona = detail.data;
  return (
    <div className="persona-preview" data-testid="persona-preview">
      <p className="persona-preview-identity mono">{persona.identity}</p>
      <p className="settings-note">
        {persona.aliases.length > 0 && t(
          `工具形态：${persona.aliases.map((alias) => alias.as).join("、")}`,
          `Tool shapes: ${persona.aliases.map((alias) => alias.as).join(", ")}`,
        )}
        {persona.hideBuiltIns.length > 0 && ` · ${t(`隐藏 ${persona.hideBuiltIns.length} 个内置工具`, `${persona.hideBuiltIns.length} built-in tools hidden`)}`}
      </p>
    </div>
  );
}
