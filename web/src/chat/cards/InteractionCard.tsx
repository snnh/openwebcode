import { useState, type ReactElement } from "react";
import { useI18n } from "../../i18n";
import { Icon } from "../../components/Icon";
import type { InteractionCardProps } from "../types";

/** 「其他」选项的客户端保留 id：回答提交时映射为 other:<自定义文本>。 */
const OTHER_ID = "other";

/** ask_user 交互卡：confirm / single_select / multi_select / text 四种回答形态。
 *  select 类型且 allowOther 时附加「其他」选项 + 自定义文本输入框。
 *  收起态（待回答区手风琴的非展开项）只渲染卡头 + 主操作按钮：卡在窄屏/多卡并存时
 *  不会把选项与提交按钮挤出可视区（主列不滚动，超出即裁切）。 */
export function InteractionCard({ item, onRespond, collapsed = false, onToggleCollapse }: InteractionCardProps): ReactElement {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [other, setOther] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const isSelect = item.kind === "single_select" || item.kind === "multi_select";
  const submit = (): void => {
    if (item.kind === "confirm") { onRespond(true); return; }
    if (item.kind === "text") { onRespond(text); return; }
    const answer = selected.map((id) => id === OTHER_ID ? `other:${other.trim()}` : id);
    onRespond(item.kind === "single_select" ? answer[0] : answer);
  };
  const disabled = (item.kind === "text" && !text.trim())
    || (isSelect && selected.filter((id) => id !== OTHER_ID || other.trim() !== "").length === 0);
  return (
    <section
      className={`interaction-card pending-block${collapsed ? " collapsed" : ""}`}
      aria-label={item.title}
    >
      <div className="pending-head">
        {onToggleCollapse ? (
          <button
            type="button"
            className="pending-toggle"
            aria-expanded={!collapsed}
            aria-label={t(`收起/展开「${item.title}」`, `Collapse or expand "${item.title}"`)}
            onClick={onToggleCollapse}
          >
            <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
            <span className="pending-title">{item.title}</span>
          </button>
        ) : <strong className="pending-title">{item.title}</strong>}
        <span className="pending-flag">{t("待回答", "Waiting")}</span>
      </div>
      {!collapsed && (
        <div className="pending-body">
          <p>{item.prompt}</p>
          {item.kind === "text" && (
            <textarea value={text} onChange={(event) => setText(event.target.value)} aria-label={t("回答", "Answer")} />
          )}
          {item.options?.map((option) => (
            <label key={option.id}>
              <input
                type={item.kind === "multi_select" ? "checkbox" : "radio"}
                name={item.id}
                checked={selected.includes(option.id)}
                onChange={() => setSelected((previous) => item.kind === "multi_select"
                  ? previous.includes(option.id) ? previous.filter((id) => id !== option.id) : [...previous, option.id]
                  : [option.id])}
              />
              {" "}{option.label}{option.description ? ` — ${option.description}` : ""}
            </label>
          ))}
          {isSelect && item.allowOther && (
            <div className="interaction-other">
              <label>
                <input
                  type={item.kind === "multi_select" ? "checkbox" : "radio"}
                  name={item.id}
                  checked={selected.includes(OTHER_ID)}
                  onChange={() => setSelected((previous) => item.kind === "multi_select"
                    ? previous.includes(OTHER_ID) ? previous.filter((id) => id !== OTHER_ID) : [...previous, OTHER_ID]
                    : [OTHER_ID])}
                />
                {" "}{t("其他", "Other")}
              </label>
              <input
                className="interaction-other-input"
                type="text"
                value={other}
                disabled={!selected.includes(OTHER_ID)}
                onChange={(event) => setOther(event.target.value)}
                aria-label={t("其他回答", "Other answer")}
                placeholder={t("请输入自定义回答", "Enter a custom answer")}
              />
            </div>
          )}
        </div>
      )}
      <div className="interaction-actions">
        <button className="btn small" onClick={submit} disabled={disabled}>
          {item.kind === "confirm" ? t("确认", "Confirm") : t("提交回答", "Submit answer")}
        </button>
        {item.kind === "confirm" && <button className="btn small" onClick={() => onRespond(false)}>{t("取消", "Cancel")}</button>}
      </div>
    </section>
  );
}
