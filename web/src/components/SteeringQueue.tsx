import type { ReactElement } from "react";

export interface SteeringItem {
  id: string;
  content: string;
  createdAt: string;
}

export function SteeringQueue({ items, onRemove }: {
  items: SteeringItem[];
  onRemove(itemId: string): void;
}): ReactElement {
  return (
    <div className="steering-queue">
      <b>Steering 队列</b>
      {items.map((item, index) => (
        <div key={item.id}>
          <span>{index + 1}</span>
          <p title={item.content}>{item.content}</p>
          <button onClick={() => onRemove(item.id)}>撤销</button>
        </div>
      ))}
    </div>
  );
}
