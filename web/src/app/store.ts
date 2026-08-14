import { useSyncExternalStore } from "react";

type StoreUpdater<T> = Partial<T> | ((previous: T) => Partial<T>);

/**
 * 轻量可观察 store（无第三方依赖）：UI 状态的单一来源。
 * 状态不可变更新（set 浅合并），订阅者按选择器取切片。
 */
interface Store<T> {
  get(): T;
  set(updater: StoreUpdater<T>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(updater) {
      const partial = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...partial };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 订阅 store 切片。选择器必须返回原始值或状态中引用稳定的字段
 * （每次 set 都是浅合并的不可变更新，未触碰的字段引用不变）；
 * 在选择器内现场构造新对象会导致快照抖动，应改为记忆化或拆分选择。
 */
export function useStore<T extends object, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
