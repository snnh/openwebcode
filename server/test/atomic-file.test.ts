import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceFileWithRetry, writeUtf8Atomically } from "../src/atomic-file.js";

function sharingViolation(code: "EPERM" | "EACCES" | "EBUSY" = "EPERM"): NodeJS.ErrnoException {
  return Object.assign(new Error("file is temporarily in use"), { code });
}

describe("replaceFileWithRetry", () => {
  it("retries transient Windows sharing violations without deleting the previous target", async () => {
    let attempts = 0;
    const delays: number[] = [];
    await replaceFileWithRetry("ledger.tmp", "ledger.json", {
      platform: "win32",
      retryDelaysMs: [5, 10],
      renameFile: async () => {
        attempts += 1;
        if (attempts < 3) throw sharingViolation();
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    expect(attempts).toBe(3);
    expect(delays).toEqual([5, 10]);
  });

  it("does not retry permanent or non-Windows rename failures", async () => {
    const permanent = Object.assign(new Error("read-only directory"), { code: "EROFS" });
    await expect(replaceFileWithRetry("tmp", "target", {
      platform: "win32",
      renameFile: async () => { throw permanent; },
      sleep: async () => undefined,
    })).rejects.toBe(permanent);

    let attempts = 0;
    await expect(replaceFileWithRetry("tmp", "target", {
      platform: "linux",
      renameFile: async () => { attempts += 1; throw sharingViolation("EBUSY"); },
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "EBUSY" });
    expect(attempts).toBe(1);
  });
});

describe("writeUtf8Atomically mode", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-atomic-"));
    roots.push(root);
    return root;
  }

  it("POSIX 平台写后 chmod 目标文件", async () => {
    const root = await makeRoot();
    const target = path.join(root, "secret.json");
    const chmodCalls: Array<{ target: string; mode: number }> = [];
    await writeUtf8Atomically(target, "{}\n", {
      platform: "linux",
      mode: 0o600,
      chmodFile: async (file, mode) => { chmodCalls.push({ target: file, mode }); },
    });
    expect(chmodCalls).toEqual([{ target, mode: 0o600 }]);
  });

  it("Windows 平台不 chmod（no-op）", async () => {
    const root = await makeRoot();
    const target = path.join(root, "secret.json");
    let chmodCalled = false;
    await writeUtf8Atomically(target, "{}\n", {
      platform: "win32",
      mode: 0o600,
      chmodFile: async () => { chmodCalled = true; },
    });
    expect(chmodCalled).toBe(false);
  });

  it.skipIf(process.platform === "win32")("POSIX 实文件断言权限位 0600", async () => {
    const root = await makeRoot();
    const target = path.join(root, "secret.json");
    await writeUtf8Atomically(target, "{}\n", { mode: 0o600 });
    expect(stat(target).then((info) => info.mode & 0o777)).resolves.toBe(0o600);
    // 复写已存在文件同样收紧（rename 保留临时文件权限，chmod 兜底）
    await writeUtf8Atomically(target, "{\"a\":1}\n", { mode: 0o600 });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("临时文件创建即带 0600（rename 前已无宽松 umask 可读窗口）", async () => {
    const root = await makeRoot();
    const target = path.join(root, "secret.json");
    let tempModeAtRename: number | undefined;
    await writeUtf8Atomically(target, "{}\n", {
      mode: 0o600,
      // 在 rename 前断言临时文件权限位：证明 mode 是创建时携带而非事后 chmod 兜底
      renameFile: async (from, to) => {
        tempModeAtRename = (await stat(from)).mode & 0o777;
        await rename(from, to);
      },
    });
    expect(tempModeAtRename).toBe(0o600);
  });
});
