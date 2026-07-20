import type { ReactElement } from "react";
import { useI18n } from "../i18n";

export interface SteeringItem {
  id: string;
  content: string;
  createdAt: string;
}

export function SteeringQueue({ items, onRemove }: {
  items: SteeringItem[];
  onRemove(itemId: string): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <div className="steering-queue">
      <b>{t("Steering 队列", "Steering queue")}</b>
      {items.map((item, index) => (
        <div key={item.id}>
          <span>{index + 1}</span>
          <p title={item.content}>{item.content}</p>
          <button onClick={() => onRemove(item.id)} title={t("撤销", "Remove")} aria-label={t("撤销", "Remove")}>{t("撤销", "Remove")}</button>
        </div>
      ))}
    </div>
  );
}
