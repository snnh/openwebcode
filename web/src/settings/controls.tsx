/**
 * 设置页通用控件：分组卡片 / 行式字段 / 开关 / 分段选择。
 * 只服务设置界面，不替换全局按钮或聊天区组件。
 */
import type { ReactElement, ReactNode } from "react";

export function SettingsCard({ title, description, children, className, flush = false }: {
  title: string;
  description?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
  /** 卡片主体去掉左右内边距（列表类内容） */
  flush?: boolean | undefined;
}): ReactElement {
  return (
    <section className={`settings-card${className ? ` ${className}` : ""}`}>
      <header className="settings-card-head">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </header>
      <div className={`settings-card-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

export function SettingsRow({ label, description, children, stack = false, inline = false, htmlFor }: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  /** 控件独占下一行（色卡、预览、文本域等宽内容） */
  stack?: boolean | undefined;
  /** 窄屏也保持左右两端（开关行） */
  inline?: boolean | undefined;
  htmlFor?: string | undefined;
}): ReactElement {
  return (
    <div className={`settings-row${stack ? " stack" : ""}${inline ? " inline" : ""}`}>
      <div className="settings-row-text">
        <label className="settings-row-label" htmlFor={htmlFor}>{label}</label>
        {description && <p className="settings-row-desc">{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** 即时生效的布尔项：按钮语义的 switch，整行由调用方包裹点击 */
export function Switch({ checked, onChange, label, disabled = false }: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean | undefined;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? " on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden />
    </button>
  );
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
}

/** 分段单选：输入用原生 radio，键盘与读屏语义保留 */
export function Segmented<T extends string | number>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange(value: T): void;
  ariaLabel: string;
}): ReactElement {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <label key={String(option.value)} className={`segmented-item${option.value === value ? " active" : ""}`}>
          <input
            type="radio"
            name={ariaLabel}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
