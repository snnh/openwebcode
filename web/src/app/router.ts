import { useSyncExternalStore } from "react";

/**
 * 极简 History API 路由：chat / workbench / share 三条路由。
 * share 路由绕过 AuthGate（公开访问），由 main.tsx 分流渲染。
 */
type Route =
  | { name: "chat" }
  | { name: "workbench" }
  | { name: "share"; shareId: string; slug: string };

/** 解析路径为路由；未知路径回落 chat（share 需整段匹配，尾部多余路径不命中） */
export function parsePath(pathname: string): Route {
  const shareMatch = pathname.match(/^\/share\/([\w-]+)\/([\w-]+)$/);
  if (shareMatch) return { name: "share", shareId: shareMatch[1]!, slug: shareMatch[2]! };
  if (pathname === "/workbench") return { name: "workbench" };
  return { name: "chat" };
}

type Listener = () => void;

class Router {
  private listeners = new Set<Listener>();
  private current: Route;

  constructor() {
    this.current = parsePath(window.location.pathname);
    window.addEventListener("popstate", () => {
      this.current = parsePath(window.location.pathname);
      this.notify();
    });
  }

  getRoute(): Route {
    return this.current;
  }

  navigate(path: string): void {
    window.history.pushState({}, "", path);
    this.current = parsePath(path);
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const router = new Router();

/** 订阅当前路由（popstate 与 navigate 均触发重渲染） */
export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => router.subscribe(cb),
    () => router.getRoute(),
  );
}
