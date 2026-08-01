import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAccessUrls, listLanAddresses, regenerateAccessToken, resolveAccessToken } from "../src/access-token.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("access-token store", () => {
  it("首次生成 64 位 hex 并持久化；再次解析复用同一令牌", async () => {
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    const first = await resolveAccessToken({ filePath });
    expect(first.source).toBe("generated");
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(filePath, "utf8")).trim()).toBe(first.token);
    const second = await resolveAccessToken({ filePath });
    expect(second).toEqual(first);
  });

  it("POSIX 下令牌文件为 0600", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    await resolveAccessToken({ filePath });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("显式 env token 优先且不写文件；过短 env token 拒绝", async () => {
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    const envToken = "e".repeat(32);
    const resolved = await resolveAccessToken({ envToken, filePath });
    expect(resolved).toEqual({ token: envToken, source: "env" });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
    await expect(resolveAccessToken({ envToken: "short", filePath })).rejects.toThrow(/at least 32/);
  });

  it("文件内容损坏时重新生成并覆盖", async () => {
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    await writeFile(filePath, "corrupted\n", "utf8");
    const resolved = await resolveAccessToken({ filePath });
    expect(resolved.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(filePath, "utf8")).trim()).toBe(resolved.token);
  });

  it("regenerate 产出新令牌并持久化", async () => {
    const root = await tempRoot("owc-access-token-");
    const filePath = path.join(root, "access-token");
    const first = await resolveAccessToken({ filePath });
    const next = await regenerateAccessToken(filePath);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect(next).not.toBe(first.token);
    expect((await resolveAccessToken({ filePath })).token).toBe(next);
  });
});

describe("buildAccessUrls", () => {
  const token = "t".repeat(64);
  it("具体地址直接拼接；IPv6 加方括号", () => {
    expect(buildAccessUrls("192.168.1.5", 3000, [], token)).toEqual([`http://192.168.1.5:3000/?token=${token}`]);
    expect(buildAccessUrls("fd00::1", 3000, [], token)).toEqual([`http://[fd00::1]:3000/?token=${token}`]);
  });
  it("通配监听用 LAN 地址展开；枚举不到回退通配符本身", () => {
    expect(buildAccessUrls("0.0.0.0", 3000, ["10.0.0.2", "192.168.1.5"], token)).toEqual([
      `http://10.0.0.2:3000/?token=${token}`,
      `http://192.168.1.5:3000/?token=${token}`,
    ]);
    expect(buildAccessUrls("0.0.0.0", 3000, [], token)).toEqual([`http://0.0.0.0:3000/?token=${token}`]);
  });
  it("listLanAddresses 返回字符串数组（本机可能为空）", () => {
    const addresses = listLanAddresses();
    expect(Array.isArray(addresses)).toBe(true);
    for (const address of addresses) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
