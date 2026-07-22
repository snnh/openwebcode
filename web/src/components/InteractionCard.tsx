import { useState, type ReactElement } from "react";
import type { InteractionRequest } from "../lib/contracts";
import { useI18n } from "../i18n";

export function InteractionCard({ item, onRespond }: { item: InteractionRequest; onRespond(answer: unknown): void }): ReactElement {
  const { t } = useI18n(); const [text, setText] = useState(""); const [selected, setSelected] = useState<string[]>([]);
  const submit = (): void => onRespond(item.kind === "confirm" ? true : item.kind === "text" ? text : item.kind === "single_select" ? selected[0] : selected);
  return <section className="interaction-card" aria-label={item.title}>
    <strong>{item.title}</strong><p>{item.prompt}</p>
    {item.kind === "text" && <textarea value={text} onChange={(event) => setText(event.target.value)} aria-label={t("回答", "Answer")} />}
    {item.options?.map((option) => <label key={option.id}><input type={item.kind === "multi_select" ? "checkbox" : "radio"} name={item.id} checked={selected.includes(option.id)} onChange={() => setSelected((previous) => item.kind === "multi_select" ? previous.includes(option.id) ? previous.filter((id) => id !== option.id) : [...previous, option.id] : [option.id])} /> {option.label}{option.description ? ` — ${option.description}` : ""}</label>)}
    <div><button className="btn small" onClick={submit} disabled={(item.kind === "text" && !text.trim()) || ((item.kind === "single_select" || item.kind === "multi_select") && selected.length === 0)}>{item.kind === "confirm" ? t("确认", "Confirm") : t("提交回答", "Submit answer")}</button>{item.kind === "confirm" && <button className="btn small" onClick={() => onRespond(false)}>{t("取消", "Cancel")}</button>}</div>
  </section>;
}
