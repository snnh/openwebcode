import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

// hasSessionCwd 的内存 cwd 引用计数集：prompt-override 项目作用域写入的校验
// 不再每次全量 list()。钉住 create/delete/重建的同步语义（含同 cwd 多会话）。

async function storeAt(root: string): Promise<SessionStore> {
  const store = new SessionStore(path.join(root, "sessions"));
  await store.initialize();
  return store;
}

describe("SessionStore.hasSessionCwd (in-memory cwd set)", () => {
  it("unknown cwd is false; created session cwd is true", async () => {
    const root = await tempRoot("owc-cwdset-");
    const store = await storeAt(root);
    const cwd = path.join(os.tmpdir(), "owc-cwdset-workspace");
    expect(await store.hasSessionCwd(cwd)).toBe(false);

    await store.create({ cwd, provider: "p", model: "m" });
    expect(await store.hasSessionCwd(cwd)).toBe(true);
    // 与 list() 同款 path.resolve 归一：相对形态等价命中
    expect(await store.hasSessionCwd(path.join(cwd, "."))).toBe(true);
  });

  it("shared cwd survives deleting one of two sessions, gone after both", async () => {
    const root = await tempRoot("owc-cwdset-");
    const store = await storeAt(root);
    const cwd = path.join(os.tmpdir(), "owc-cwdset-shared");
    const a = await store.create({ cwd, provider: "p", model: "m" });
    const b = await store.create({ cwd, provider: "p", model: "m" });
    expect(await store.hasSessionCwd(cwd)).toBe(true); // 建缓存

    await store.delete(a.id);
    expect(await store.hasSessionCwd(cwd)).toBe(true);
    await store.delete(b.id);
    expect(await store.hasSessionCwd(cwd)).toBe(false);
  });

  it("a fresh store instance rebuilds the cwd set from disk", async () => {
    const root = await tempRoot("owc-cwdset-");
    const store = await storeAt(root);
    const cwd = path.join(os.tmpdir(), "owc-cwdset-rebuild");
    await store.create({ cwd, provider: "p", model: "m" });

    const fresh = await storeAt(root);
    expect(await fresh.hasSessionCwd(cwd)).toBe(true);
    expect(await fresh.hasSessionCwd(path.join(os.tmpdir(), "owc-cwdset-other"))).toBe(false);
  });
});
