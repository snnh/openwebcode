import { describe, expect, it } from "vitest";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { makeTestApp } from "./helpers/test-app.js";

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const setup = await makeTestApp({
    tempPrefix: "owc-session-defaults-",
    settingsEnv: env,
    configureProviders: (providers) => providers.register(makeStubProvider("stub")),
  });
  return setup;
}

describe("新建会话套用全局默认（defaultEffort / defaultSnapshotMode）", () => {
  it("设置非缺省时：新会话带上 effort 与 snapshotMode", async () => {
    const setup = await fixture({ OWC_DEFAULT_EFFORT: "high", OWC_DEFAULT_SNAPSHOT_MODE: "manual" });
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({ effort: "high", snapshotMode: "manual" });
      // 事件与落盘 meta 一致
      const meta = await setup.sessions.get(response.json<{ id: string }>().id);
      expect(meta).toMatchObject({ effort: "high", snapshotMode: "manual" });
    } finally {
      await setup.app.close();
    }
  });

  it("缺省（none/auto）：新会话不带 effort 与 snapshotMode", async () => {
    const setup = await fixture();
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json<Record<string, unknown>>();
      expect(body.effort).toBeUndefined();
      expect(body.snapshotMode).toBeUndefined();
    } finally {
      await setup.app.close();
    }
  });

  it("非法枚举值（env 直写）：静默跳过，不阻断创建", async () => {
    const setup = await fixture({ OWC_DEFAULT_EFFORT: "bogus" });
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<Record<string, unknown>>().effort).toBeUndefined();
    } finally {
      await setup.app.close();
    }
  });

  it("会话自身 PUT config 覆盖优先于全局默认", async () => {
    const setup = await fixture({ OWC_DEFAULT_EFFORT: "high" });
    try {
      const created = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      const id = created.json<{ id: string }>().id;
      const updated = await setup.app.inject({ method: "PUT", url: `/api/sessions/${id}/config`, payload: { effort: "low" } });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({ effort: "low" });
    } finally {
      await setup.app.close();
    }
  });
});

describe("新建会话套用快照后端偏好（snapshotBackend）", () => {
  it("git-shadow：直接预设，跳过探测链", async () => {
    const setup = await fixture({ OWC_SNAPSHOT_BACKEND: "git-shadow" });
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({ snapshotBackend: "git-shadow" });
    } finally {
      await setup.app.close();
    }
  });

  it("指定后端在当前平台不可用（win32 指定 btrfs）：回落自动并告警，不阻断创建", async () => {
    const setup = await fixture({ OWC_SNAPSHOT_BACKEND: "btrfs" });
    try {
      const response = await setup.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: setup.root, provider: "stub", model: "m" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<Record<string, unknown>>().snapshotBackend).toBeUndefined();
      const fallback = setup.observed.find((event) => event.type === "snapshot.backend_fallback");
      expect(fallback).toMatchObject({ payload: { preferred: "btrfs" } });
    } finally {
      await setup.app.close();
    }
  });
});
