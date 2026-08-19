import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureHomeEnv, wellKnownBinPaths } from "../src/host-env.js";
import { runHostResolving } from "../src/python-env.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("ensureHomeEnv（systemd/Docker 最小环境适配）", () => {
  it("HOME 已设置时不动", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/user" };
    ensureHomeEnv(env, () => "/home/from-passwd", "linux");
    expect(env.HOME).toBe("/home/user");
  });

  it("HOME 缺失/为空时按 homedir 补齐", () => {
    const env: NodeJS.ProcessEnv = {};
    ensureHomeEnv(env, () => "/home/from-passwd", "linux");
    expect(env.HOME).toBe("/home/from-passwd");
    const empty: NodeJS.ProcessEnv = { HOME: "" };
    ensureHomeEnv(empty, () => "/home/from-passwd", "linux");
    expect(empty.HOME).toBe("/home/from-passwd");
  });

  it("homedir 解析为空时保持未设（不写入空串）", () => {
    const env: NodeJS.ProcessEnv = {};
    ensureHomeEnv(env, () => "", "linux");
    expect(env.HOME).toBeUndefined();
  });

  it("win32 不动（home 语义走 USERPROFILE）", () => {
    const env: NodeJS.ProcessEnv = {};
    ensureHomeEnv(env, () => "C:\\Users\\x", "win32");
    expect(env.HOME).toBeUndefined();
  });
});

describe("wellKnownBinPaths", () => {
  it("linux：用户级 bin 优先，系统目录兜底", () => {
    expect(wellKnownBinPaths("uv", () => "/home/u", "linux")).toEqual([
      "/home/u/.local/bin/uv",
      "/home/u/.cargo/bin/uv",
      "/usr/local/bin/uv",
      "/usr/bin/uv",
    ]);
  });

  it("darwin 追加 /opt/homebrew/bin；homedir 为空跳过用户级候选", () => {
    expect(wellKnownBinPaths("uv", () => "/home/u", "darwin").at(-1)).toBe("/opt/homebrew/bin/uv");
    expect(wellKnownBinPaths("uv", () => "", "linux")).toEqual(["/usr/local/bin/uv", "/usr/bin/uv"]);
  });

  it("win32 返回空（保持原报错路径）", () => {
    expect(wellKnownBinPaths("uv", () => "C:\\Users\\x", "win32")).toEqual([]);
  });
});

describe("runHostResolving", () => {
  it("PATH 命中时直接返回，不查候选", async () => {
    // node 必然在测试进程 PATH 上；候选给一个必失败路径，PATH 命中则不会触碰候选
    const result = await runHostResolving(process.execPath, ["--version"], 15_000, ["/nonexistent/bin/node"]);
    expect(result.code).toBe(0);
  });

  it("spawn 失败且无候选可命中时返回最初的失败", async () => {
    const result = await runHostResolving("owc-definitely-not-a-command-9f3b2c", ["--version"], 15_000, []);
    expect(result.code).toBeNull();
  });

  it.skipIf(process.platform === "win32")("PATH 未命中时回退到候选绝对路径", async () => {
    const root = await tempRoot("owc-host-env-");
    const fake = path.join(root, "fake-uv");
    await writeFile(fake, "#!/bin/sh\necho fake-stderr >&2\nexit 0\n");
    await chmod(fake, 0o755);
    const result = await runHostResolving("owc-definitely-not-a-command-9f3b2c", ["--version"], 15_000, [fake]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("fake-stderr");
  });
});
