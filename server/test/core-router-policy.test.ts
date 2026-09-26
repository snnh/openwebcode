import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nodeToolchainWritePaths } from "../src/node-env.js";
import { uvVenvDir } from "../src/python-env.js";
import { CoreRouter, gitCredentialReadOnlyPaths, nodeEnvReadOnlyPaths, toolchainWritePaths } from "../src/sandbox/core-router.js";
import type { SandboxPolicy, SessionMeta } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

const policy: SandboxPolicy = { enabled: true, readRoots: ["/work"], writeRoots: ["/work"], denyPaths: [], network: "allow" };
const baseMeta: SessionMeta = {
  id: "s1", cwd: "/work", provider: "", model: "", title: "t",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sandbox: policy,
};

function meta(sandboxMode: SessionMeta["sandboxMode"]): SessionMeta | undefined {
  return sandboxMode ? { ...baseMeta, sandboxMode } : undefined;
}

/** 临时 $HOME 凭据夹具：.gitconfig（默认并入）+ .ssh（opt-in 才并入）。 */
async function credentialHome() {
  const home = await tempRoot("owc-gh-cred-");
  await writeFile(path.join(home, ".gitconfig"), "[user]\n");
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  return { home, config: path.join(home, ".gitconfig"), ssh: path.join(home, ".ssh") };
}

describe("CoreRouter.policyFor 平台分支", () => {
  it("未显式选择与 POSIX landlock 都不下发 mode（core 自选默认后端）；显式档位原样下发", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, platform)).toMatchObject({ enabled: true });
      expect(CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, platform).mode, platform).toBeUndefined();
      // POSIX 上显式 landlock 与缺省同语义
      expect(CoreRouter.policyFor(meta("landlock"), policy, undefined, undefined, platform).mode, platform).toBeUndefined();
    }
    // 显式档位不受平台分支影响（含持久化的 jobobject）
    expect(CoreRouter.policyFor(meta("jobobject"), policy, undefined, undefined, "linux").mode).toBe("jobobject");
    expect(CoreRouter.policyFor(meta("jobobject"), policy, undefined, undefined, "win32").mode).toBe("jobobject");
    expect(CoreRouter.policyFor(meta("appcontainer"), policy, undefined, undefined, "linux").mode).toBe("appcontainer");
    expect(CoreRouter.policyFor(meta("bubblewrap"), policy, undefined, undefined, "linux")).toMatchObject({ mode: "bubblewrap", enabled: true });
  });

  it("wsb/off 关闭沙盒并丢弃 bindLinks（与平台无关）", () => {
    const wsb = CoreRouter.policyFor(meta("wsb"), { ...policy, bindLinks: [{ virtPath: "C:\\x", backingPath: "D:\\b" }] }, undefined, undefined, "linux");
    expect(wsb).toMatchObject({ enabled: false });
    expect(wsb.bindLinks).toBeUndefined();
    expect(CoreRouter.policyFor(meta("off"), policy, undefined, undefined, "linux").enabled).toBe(false);
  });
});

describe("nodeEnvReadOnlyPaths（与 nodeEnv 绑定的工具链只读放行）", () => {
  it("nvm/fnm 走读写层不再进只读层；global 解析宿主 PATH 工具链根（上限 32 / win32 仅用户 profile）", () => {
    const nvmDeps = { nvmDir: "/home/u/.nvm", exists: (target: string) => target === "/home/u/.nvm/nvm.sh" };
    // 既有配置原样保留（含已含 nvmDir 的情况）；project 与版本管理器不追加
    expect(nodeEnvReadOnlyPaths(["/work/ro"], "nvm", "linux", nvmDeps)).toEqual(["/work/ro"]);
    expect(nodeEnvReadOnlyPaths(["/home/u/.nvm"], "nvm", "linux", nvmDeps)).toEqual(["/home/u/.nvm"]);
    expect(nodeEnvReadOnlyPaths(undefined, "nvm", "linux", nvmDeps)).toEqual([]);
    expect(nodeEnvReadOnlyPaths(undefined, "fnm", "linux", { home: "/home/u", exists: () => true })).toEqual([]);
    expect(nodeEnvReadOnlyPaths(undefined, "project", "linux")).toEqual([]);

    const existing = Array.from({ length: 31 }, (_, index) => `/ro/${index}`);
    const merged = nodeEnvReadOnlyPaths(existing, "global", "linux", {
      pathEnv: "/opt/node/bin:/usr/bin",
      exists: (target: string) => target === "/opt/node/bin/node" || target === "/usr/bin/node",
      realpath: (target: string) => target,
    });
    expect(merged).toHaveLength(32);
    expect(merged.at(-1)).toBe("/opt/node");

    // win32：系统/自定义/盘根跳过；PATH 条目与 realpath 目标( junction )同时并入
    const winDeps = { home: "C:\\Users\\u", exists: (target: string) => target.includes("node.exe"), realpath: (target: string) => target };
    expect(nodeEnvReadOnlyPaths(undefined, "global", "win32", {
      ...winDeps, pathEnv: "C:\\Users\\u\\node;C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\;D:\\tools\\node",
    })).toEqual(["C:\\Users\\u\\node"]);
    expect(nodeEnvReadOnlyPaths(undefined, "global", "win32", {
      home: "C:\\Users\\u",
      pathEnv: "C:\\Users\\u\\AppData\\Local\\fnm_multishells\\123",
      exists: (target: string) => target.includes("node.exe") || target.includes("fnm_multishells"),
      realpath: () => "C:\\Users\\u\\AppData\\Local\\fnm\\node-versions\\v20.0.0\\installation",
    })).toEqual([
      "C:\\Users\\u\\AppData\\Local\\fnm\\node-versions\\v20.0.0\\installation",
      "C:\\Users\\u\\AppData\\Local\\fnm_multishells\\123",
    ]);
  });
});

describe("CoreRouter.configureSession 工具链挂载", () => {
  function makeRouter(sessionMeta: SessionMeta, platform: NodeJS.Platform = "linux") {
    const captured: SandboxPolicy[] = [];
    const client = { on() { return client; }, start: async () => {}, configureSession: async (request: { sandbox: SandboxPolicy }) => { captured.push(request.sandbox); return { sandboxCapability: "enforced" as const }; } };
    const router = new CoreRouter(client as never, { get: async () => sessionMeta } as never, {} as never, undefined, undefined, platform);
    return { captured, router };
  }

  it("按生效 nodeEnv 并入挂载：会话值优先，缺省跟随全局默认解析器", async () => {
    const home = await tempRoot("owc-node-mount-");
    const nvmDir = path.join(home, ".nvm");
    await mkdir(nvmDir, { recursive: true });
    await writeFile(path.join(nvmDir, "nvm.sh"), "# nvm\n");
    vi.stubEnv("NVM_DIR", nvmDir);
    try {
      const nvm = makeRouter({ ...baseMeta, nodeEnv: "nvm" });
      await nvm.router.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
      expect(nvm.captured[0]?.allowPaths).toContain(nvmDir);
      expect(nvm.captured[0]?.readOnlyPaths ?? []).not.toContain(nvmDir);

      const fallback = makeRouter({ ...baseMeta });
      await fallback.router.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
      expect(fallback.captured[0]?.allowPaths ?? []).not.toContain(nvmDir);
      fallback.router.setNodeEnvDefault(() => "nvm");
      await fallback.router.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
      expect(fallback.captured[1]?.allowPaths).toContain(nvmDir);
      expect(fallback.captured[1]?.readOnlyPaths ?? []).not.toContain(nvmDir);

      const fnmDir = await tempRoot("owc-fnm-mount-");
      vi.stubEnv("FNM_DIR", fnmDir);
      const fnm = makeRouter({ ...baseMeta, nodeEnv: "fnm" });
      await fnm.router.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
      expect(fnm.captured[0]?.allowPaths).toContain(fnmDir);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uv-config 的 venv 进 allowPaths；仅 AppContainer 缺省档挂载，win32 jobobject 档不挂载", async () => {
    const dataDir = await tempRoot("owc-uv-mount-");
    const venv = uvVenvDir("uv-config", "/work", dataDir);
    expect(venv).toBeDefined();

    for (const [platform, cwd] of [["linux", "/work"], ["win32", "D:\\work"]] as const) {
      const mounted = makeRouter({ ...baseMeta }, platform);
      mounted.router.setPythonEnvDefault(() => "uv-config", dataDir);
      await mounted.router.configureSession({ sessionId: "s1", cwd, sandbox: policy });
      expect(mounted.captured[0]?.allowPaths, platform).toContain(venv);
    }

    const winJob = makeRouter({ ...baseMeta, sandboxMode: "jobobject", nodeEnv: "fnm" }, "win32");
    await winJob.router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
    expect(winJob.captured[0]?.allowPaths ?? []).toHaveLength(0);
    expect(winJob.captured[0]?.readOnlyPaths ?? []).toHaveLength(0);
  });

  describe.skipIf(process.platform !== "win32")("configureSession win32 真机目录（AppContainer 缺省档）", () => {
    it("fnm 目录进 allowPaths；只读层只放行用户 profile 内的 node 工具链", async () => {
      const home = await tempRoot("owc-win-toolchain-");
      const fnmDir = path.join(home, "AppData", "Local", "fnm");
      const nodeDir = path.join(home, "node");
      const outside = path.join(home, "..", "owc-win-outside", "node");
      await Promise.all([mkdir(fnmDir, { recursive: true }), mkdir(nodeDir, { recursive: true }), mkdir(outside, { recursive: true })]);
      await Promise.all([writeFile(path.join(nodeDir, "node.exe"), "x"), writeFile(path.join(outside, "node.exe"), "x")]);
      for (const [key, value] of [["FNM_DIR", fnmDir], ["USERPROFILE", home], ["HOME", home]] as const) vi.stubEnv(key, value);
      vi.stubEnv("PATH", `${outside};${nodeDir};C:\\Windows\\System32`);
      try {
        const fnm = makeRouter({ ...baseMeta, nodeEnv: "fnm" }, "win32");
        await fnm.router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
        expect(fnm.captured[0]?.allowPaths).toContain(fnmDir);

        const global = makeRouter({ ...baseMeta }, "win32");
        await global.router.configureSession({ sessionId: "s1", cwd: "D:\\work", sandbox: policy });
        expect(global.captured[0]?.readOnlyPaths).toContain(nodeDir);
        expect(global.captured[0]?.readOnlyPaths ?? []).not.toContain(outside);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});

describe("toolchainWritePaths / nodeToolchainWritePaths", () => {
  it("读写层合并保留顺序、去重并受 core 上限 32 截断；win32 目录推导（FNM_DIR 覆盖）且 POSIX 语义不变", () => {
    expect(toolchainWritePaths(["/a", "/b"], ["/c", "/a"])).toEqual(["/a", "/b", "/c"]);
    expect(toolchainWritePaths(undefined, ["/x", "/x", "/y"])).toEqual(["/x", "/y"]);
    const existing = Array.from({ length: 31 }, (_, index) => `/w/${index}`);
    const merged = toolchainWritePaths(existing, ["/new/1", "/new/2"]);
    expect(merged).toHaveLength(32);
    expect(merged.at(-1)).toBe("/new/1");

    const exists = (target: string) => target === "C:\\Users\\u\\AppData\\Local\\fnm" || target === "C:\\Users\\u\\AppData\\Roaming\\nvm\\nvm.exe";
    const win = { platform: "win32" as const, home: "C:\\Users\\u" };
    expect(nodeToolchainWritePaths("fnm", { ...win, exists })).toEqual(["C:\\Users\\u\\AppData\\Local\\fnm"]);
    expect(nodeToolchainWritePaths("nvm", { ...win, exists })).toEqual(["C:\\Users\\u\\AppData\\Roaming\\nvm"]);
    // 显式 FNM_DIR 优先；目录不存在不追加
    expect(nodeToolchainWritePaths("fnm", { ...win, fnmDir: "D:\\fnm", exists: (target) => target === "D:\\fnm" })).toEqual(["D:\\fnm"]);
    expect(nodeToolchainWritePaths("fnm", { ...win, exists: () => false })).toEqual([]);
    // 屏蔽宿主 NVM_DIR/FNM_DIR：CI runner 预装 nvm 会污染默认推导
    vi.stubEnv("NVM_DIR", undefined as unknown as string);
    vi.stubEnv("FNM_DIR", undefined as unknown as string);
    try {
      expect(nodeToolchainWritePaths("nvm", { platform: "linux", home: "/home/u", exists: (target) => target === "/home/u/.nvm/nvm.sh" })).toEqual(["/home/u/.nvm"]);
      expect(nodeToolchainWritePaths("fnm", { platform: "linux", home: "/home/u", exists: () => false })).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("gitCredentialReadOnlyPaths（沙盒内 git/gh 凭据只读放行）", () => {
  it("并入 $HOME 下存在的凭据并去重；.ssh 需显式 opt-in；无文件隔离的档位不追加", async () => {
    const { home, config, ssh } = await credentialHome();
    expect(gitCredentialReadOnlyPaths(["/work/ro", config], "linux", home)).toEqual(["/work/ro", config]);
    // .ssh 默认不挂载（只读不防私钥外泄），会话显式 opt-in 才并入
    expect(gitCredentialReadOnlyPaths(undefined, "linux", home)).toEqual([config]);
    expect(gitCredentialReadOnlyPaths(undefined, "linux", home, undefined, true)).toEqual([config, ssh]);
    // win32 缺省档 = AppContainer：追加；显式 appcontainer 同
    expect(gitCredentialReadOnlyPaths(undefined, "win32", home)).toEqual([config]);
    expect(gitCredentialReadOnlyPaths(undefined, "win32", home, "appcontainer", true)).toEqual([config, ssh]);
    for (const mode of ["jobobject", "off", "wsb"] as const) expect(gitCredentialReadOnlyPaths(undefined, "win32", home, mode), mode).toEqual([]);
    // 既有配置在不追加时原样保留
    expect(gitCredentialReadOnlyPaths(["/work/ro"], "win32", home, "jobobject")).toEqual(["/work/ro"]);
  });

  it("policyFor 经 homedir 并入凭据：POSIX/win32 缺省与 appcontainer 生效，wsb/off/jobobject 不追加", async () => {
    const { home, config } = await credentialHome();
    await writeFile(path.join(home, ".git-credentials"), "https://x@github.com\n");
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    try {
      const credentials = [config, path.join(home, ".git-credentials")];
      expect(CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, "linux").readOnlyPaths).toEqual(credentials);
      expect(CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, "win32").readOnlyPaths).toEqual(credentials);
      expect(CoreRouter.policyFor(meta("appcontainer"), policy, undefined, undefined, "win32")).toMatchObject({ mode: "appcontainer", readOnlyPaths: credentials });
      for (const [mode, platform] of [["wsb", "linux"], ["off", "linux"], ["jobobject", "win32"]] as const) {
        expect(CoreRouter.policyFor(meta(mode), policy, undefined, undefined, platform).readOnlyPaths, mode).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
