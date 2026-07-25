/**
 * 全局键盘分发钩子（0.4.0 Phase 5a）：window keydown → keybindings 匹配 → 命令执行。
 * 输入框聚焦时不抢键（标记 global 的应用级键位除外）；when 上下文每次按键实时求值。
 */
import { useEffect, useRef } from "react";
import { dispatchKeybinding, DEFAULT_KEYBINDINGS, type Keybinding } from "./keybindings";
import type { WhenContext } from "./registry";

export function useGlobalKeybindings(context: WhenContext, keybindings: readonly Keybinding[] = DEFAULT_KEYBINDINGS): void {
  // 上下文存 ref，避免每次渲染重绑监听器；按键时取最新快照
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (dispatchKeybinding(event, keybindings, contextRef.current)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}
