import type { ReactElement } from "react";

/** 占位组件的通用渲染：实现代理逐个替换为真实实现，签名不得偏离 chat/types.ts */
export function NotImplemented({ name }: { name: string }): ReactElement {
  return <div data-not-implemented={name} />;
}
