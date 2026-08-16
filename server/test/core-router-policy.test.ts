import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { uvVenvDir } from "../src/python-env.js";
import { CoreRouter, gitCredentialReadOnlyPaths, nodeEnvReadOnlyPaths, toolchainWritePaths } from "../src/sandbox/core-router.js";
import type { SandboxPolicy, SessionMeta } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

const policy: SandboxPolicy = {
  enabled: true,
  readRoots: ["/work"],
  writeRoots: ["/work"],
  denyPaths: [],
  network: "allow",
};

function meta(sandboxMode: SessionMeta["sandboxMode"]): SessionMeta | undefined {
  if (!sandboxMode) return undefined;
  return {
    id: "00000000-0000-0000-0000-000000000000",
    cwd: "/work",
    provider: "",
    model: "",
    sandbox: policy,
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sandboxMode,
  };
}

describe("CoreRouter.policyFor 平台分支", () => {
  it("未显式选择时 Windows 缺省下发 jobobject", () => {
    expect(CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, "win32").mode).toBe("jobobject");
  });

  it("未显式选择时 POSIX 不下发 mode（core 无 jobobject 语义）", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const routed = CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, platform);
      expect(routed.mode).toBeUndefined();
      expect(routed.enabled).toBe(true);
    }
  });

  it("显式选择（含持久化的 jobobject）不受平台分支影响", () => {
    expect(CoreRouter.policyFor(meta("jobobject"), policy, undefined, undefined, "linux").mode).toBe("jobobject");
    expect(CoreRouter.policyFor(meta("appcontainer"), policy, undefined, undefined, "linux").mode).toBe("appcontainer");
  });

  it("wsb/off 决策与平台无关", () => {
    const wsb = CoreRouter.policyFor(meta("wsb"), { ...policy, bindLinks: [{ virtPath: "C:\\x", backingPath: "D:\\b" }] }, undefined, undefined, "linux");
    expect(wsb.enabled).toBe(false);
    expect(wsb.bindLinks).toBeUndefined();
    expect(CoreRouter.policyFor(meta("off"), policy, undefined, undefined, "linux").enabled).toBe(false);
  });

  it("POSIX 显式 landlock 不下发 mode（与缺省同语义）", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const routed = CoreRouter.policyFor(meta("landlock"), policy, undefined, undefined, platform);
      expect(routed.mode).toBeUndefined();
      expect(routed.enabled).toBe(true);
    }
  });

  it("POSIX 显式 bubblewrap 下发 mode: bubblewrap", () => {
    const routed = CoreRouter.policyFor(meta("bubblewrap"), policy, undefined, undefined, "linux");
    expect(routed.mode).toBe("bubblewrap");
    expect(routed.enabled).toBe(true);
  });
});

describe("nodeEnvReadOnlyPaths（与 nodeEnv 绑定的工具链只读放行）", () => {
  const nvmDeps = { nvmDir: "/home/u/.nvm", exists: (target: string) => target === "/home/u/.nvm/nvm.sh" };

  it("fnm/nvm 走读写层不再进只读层；project 不追加；既有配置原样保留", () => {
    expect(nodeEnvReadOnlyPaths(["/work/ro"], "nvm", "linux", nvmDeps)).toEqual(["/work/ro"]);
    expect(nodeEnvReadOnlyPaths(["/home/u/.nvm"], "nvm", "linux", nvmDeps)).toEqual(["/home/u/.nvm"]);
    expect(nodeEnvReadOnlyPaths(undefined, "nvm", "linux", nvmDeps)).toEqual([]);
    expect(nodeEnvReadOnlyPaths(undefined, "fnm", "linux", { home: "/home/u", exists: () => true })).toEqual([]);
    expect(nodeEnvReadOnlyPaths(undefined, "project", "linux")).toEqual([]);
  });

  it("core readOnlyPaths 上限 16：用户配置与凭据之后补齐截断（global 解析宿主 PATH 工具链根）", () => {
    const globalDeps = {
      pathEnv: "/opt/node/bin:/usr/bin",
      exists: (target: string) => target === "/opt/node/bin/node" || target === "/usr/bin/node",
      realpath: (target: string) => target,
    };
    const existing = Array.from({ length: 15 }, (_, index) => `/ro/${index}`);
    const merged = nodeEnvReadOnlyPaths(existing, "global", "linux", globalDeps);
    expect(merged).toHaveLength(16);
    expect(merged.at(-1)).toBe("/opt/node");
  });

  const baseMeta = {
    id: "s1",
    cwd: "/work",
    provider: "",
    model: "",
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sandbox: policy,
  };

  function makeCaptureClient() {
    const captured: SandboxPolicy[] = [];
    const client = {
      on() { return client; },
      start: async () => {},
      configureSession: async (request: { sandbox: SandboxPolicy }) => { captured.push(request.sandbox); return { sandboxCapability: "enforced" as const }; },
    };
    return { captured, client };
  }

  function makeRouter(client: unknown, sessionMeta: SessionMeta) {
    return new CoreRouter(client as never, { get: async () => sessionMeta } as never, {} as never, undefined, undefined, "linux");
  }

  it("configureSession 按生效 nodeEnv 并入挂载：nvm 进读写层，会话值优先，缺省跟随全局默认解析器", async () => {
    const home = await tempRoot("owc-node-mount-");
    const nvmDir = path.join(home, ".nvm");
    await mkdir(nvmDir, { recursive: true });
    await writeFile(path.join(nvmDir, "nvm.sh"), "# nvm\n");
    vi.stubEnv("NVM_DIR", nvmDir);
    const { captured, client } = makeCaptureClient();
    try {
      // 会话显式 nvm：版本管理器目录进 allowPaths（读写层），不进 readOnlyPaths
      const sessionMeta: SessionMeta = { ...baseMeta, nodeEnv: "nvm" };
      const router = makeRouter(client, sessionMeta);
      await router.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
      expect(captured[0]?.allowPaths).toContain(nvmDir);
      expect(captured[0]?.readOnlyPaths ?? []).not.toContain(nvmDir);

      // 会话缺省（undefined）：跟随全局默认解析器；默认 global 时读写层不追加
      captured.length = 0;
      const defaultMeta: SessionMeta = { ...baseMeta };
      const routerDefault = makeRouter(client, defaultMeta);
      await routerDefault.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
      expect(captured[0]?.allowPaths ?? []).not.toContain(nvmDir);
      expect(captured[0]?.readOnlyPaths ?? []).not.toContain(nvmDir);
      routerDefault.setNodeEnvDefault(() => "nvm");
      await routerDefault.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
      expect(captured[1]?.allowPaths).toContain(nvmDir);
      expect(captured[1]?.readOnlyPaths ?? []).not.toContain(nvmDir);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("configureSession：fnm 会话的 $FNM_DIR 进 allowPaths（读写层）", async () => {
    const fnmDir = await tempRoot("owc-fnm-mount-");
    vi.stubEnv("FNM_DIR", fnmDir);
    const { captured, client } = makeCaptureClient();
    try {
      const sessionMeta: SessionMeta = { ...baseMeta, nodeEnv: "fnm" };
      const router = makeRouter(client, sessionMeta);
      await router.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
      expect(captured[0]?.allowPaths).toContain(fnmDir);
      expect(captured[0]?.readOnlyPaths ?? []).not.toContain(fnmDir);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("setPythonEnvDefault：uv-config 默认的 venv 目录（数据目录下）进 allowPaths", async () => {
    const dataDir = await tempRoot("owc-uv-mount-");
    const { captured, client } = makeCaptureClient();
    // 会话缺省（无 pythonEnv）：跟随全局默认解析器；uv-config 的 venv 在数据目录下，必须挂载读写层
    const defaultMeta: SessionMeta = { ...baseMeta };
    const router = makeRouter(client, defaultMeta);
    router.setPythonEnvDefault(() => "uv-config", dataDir);
    await router.configureSession({ sessionId: "s1", cwd: "/work", sandbox: policy });
    const venv = uvVenvDir("uv-config", "/work", dataDir);
    expect(venv).toBeDefined();
    expect(captured[0]?.allowPaths).toContain(venv);
  });
});

describe("toolchainWritePaths（读写层合并）", () => {
  it("保留既有顺序、去重、core allowPaths 上限 16 截断", () => {
    expect(toolchainWritePaths(["/a", "/b"], ["/c", "/a"])).toEqual(["/a", "/b", "/c"]);
    expect(toolchainWritePaths(undefined, ["/x", "/x", "/y"])).toEqual(["/x", "/y"]);
    expect(toolchainWritePaths(["/a"], [])).toEqual(["/a"]);
    const existing = Array.from({ length: 15 }, (_, index) => `/w/${index}`);
    const merged = toolchainWritePaths(existing, ["/new/1", "/new/2"]);
    expect(merged).toHaveLength(16);
    expect(merged.at(-1)).toBe("/new/1");
  });
});

describe("gitCredentialReadOnlyPaths（沙盒内 git/gh 凭据只读放行）", () => {
  it("POSIX：并入 $HOME 下存在的凭据路径并去重，不存在的跳过", async () => {
    const home = await tempRoot("owc-gh-cred-");
    await writeFile(path.join(home, ".gitconfig"), "[user]\n");
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    const existing = ["/work/ro", path.join(home, ".gitconfig")];
    const merged = gitCredentialReadOnlyPaths(existing, "linux", home);
    expect(merged).toEqual(["/work/ro", path.join(home, ".gitconfig"), path.join(home, ".ssh")]);
  });

  it("win32 不追加（Job Object 无文件系统隔离，凭据本就可读）", async () => {
    const home = await tempRoot("owc-gh-cred-");
    await writeFile(path.join(home, ".gitconfig"), "[user]\n");
    expect(gitCredentialReadOnlyPaths(undefined, "win32", home)).toEqual([]);
  });

  it("policyFor 的 POSIX 分支经 homedir 并入凭据；wsb/off 不追加", async () => {
    const home = await tempRoot("owc-gh-cred-");
    await writeFile(path.join(home, ".git-credentials"), "https://x@github.com\n");
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    try {
      const routed = CoreRouter.policyFor(meta(undefined), policy, undefined, undefined, "linux");
      expect(routed.readOnlyPaths).toEqual([path.join(home, ".git-credentials")]);
      expect(CoreRouter.policyFor(meta("wsb"), policy, undefined, undefined, "linux").readOnlyPaths).toBeUndefined();
      expect(CoreRouter.policyFor(meta("off"), policy, undefined, undefined, "linux").readOnlyPaths).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
