import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { TotpAuthService, base32Decode, base32Encode, isLoopbackOrLAN, totpAt, verifyTotp } from "../src/auth-totp.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

// RFC 6238 附录 B 的 SHA1 测试密钥（ASCII "12345678901234567890"）与 8 位向量
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const RFC_VECTORS: Array<[number, string, string]> = [
  // [时间(ms), 8 位向量, 换算后的 6 位]
  [59_000, "94287082", "287082"],
  [1_111_111_109_000, "07081804", "081804"],
  [1_111_111_111_000, "14050471", "050471"],
  [1_234_567_890_000, "89005924", "005924"],
  [2_000_000_000_000, "69279037", "279037"],
  [20_000_000_000_000, "65353130", "353130"],
];

describe("TOTP RFC 6238", () => {
  it("base32 往返", () => {
    const data = Buffer.from("hello world!!", "utf8");
    expect(base32Decode(base32Encode(data)).equals(data)).toBe(true);
    expect(base32Encode(Buffer.from("12345678901234567890", "ascii"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("RFC 附录 B 时间向量（8 位取模换算 6 位）", () => {
    const secret = base32Decode(RFC_SECRET);
    for (const [timestampMs, eightDigits, sixDigits] of RFC_VECTORS) {
      expect(Number(totpAt(secret, timestampMs))).toBe(Number(eightDigits) % 1_000_000);
      expect(totpAt(secret, timestampMs)).toBe(sixDigits);
      expect(verifyTotp(secret, sixDigits, timestampMs)).toBe(true);
    }
  });

  it("±1 窗口接受相邻步长，超出拒绝", () => {
    const secret = base32Decode(RFC_SECRET);
    const at = 1_234_567_890_000;
    expect(verifyTotp(secret, totpAt(secret, at - 30_000), at)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, at + 30_000), at)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, at + 60_000), at)).toBe(false);
    expect(verifyTotp(secret, totpAt(secret, at - 60_000), at)).toBe(false);
    expect(verifyTotp(secret, "not-a-code", at)).toBe(false);
  });
});

describe("isLoopbackOrLAN", () => {
  it("回环与局域网字面量为真，通配与公网为假", () => {
    for (const host of ["127.0.0.1", "127.5.0.9", "::1", "[::1]", "localhost", "192.168.1.20", "10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.1", "fe80::1", "febf::abcd"]) {
      expect(isLoopbackOrLAN(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "172.15.0.1", "172.32.0.1", "8.8.8.8", "203.0.113.7", "2606:4700:4700::1111", "owc.example.test"]) {
      expect(isLoopbackOrLAN(host), host).toBe(false);
    }
  });
});

/** 造一个已启用 TOTP 的服务（setup→confirm 全程走真实校验） */
async function makeEnabledService(root: string, now: () => number): Promise<{ service: TotpAuthService; secret: string; recoveryCodes: string[] }> {
  const service = new TotpAuthService(path.join(root, "totp.json"), { now });
  await service.load();
  const { secret } = service.beginSetup();
  const recoveryCodes = await service.confirmSetup(totpAt(base32Decode(secret), now()));
  if (!recoveryCodes) throw new Error("confirmSetup failed in test setup");
  return { service, secret, recoveryCodes };
}

describe("TotpAuthService", () => {
  it("setup→confirm 落盘 0600，恢复码一次性用完即删", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-totp-"));
    roots.push(root);
    const currentTime = 1_700_000_000_000;
    const now = () => currentTime;
    const { service, secret, recoveryCodes } = await makeEnabledService(root, now);
    expect(service.enabled()).toBe(true);
    expect(recoveryCodes).toHaveLength(10);
    // 凭据文件权限 0600（Windows 下 chmod 尽力而为，仅 POSIX 断言）
    if (process.platform !== "win32") {
      expect((await stat(path.join(root, "totp.json"))).mode & 0o777).toBe(0o600);
    }
    const persisted = JSON.parse(await readFile(path.join(root, "totp.json"), "utf8")) as { enabled: boolean; secret: string; recoveryHashes: string[] };
    expect(persisted.enabled).toBe(true);
    expect(persisted.secret).toBe(secret);
    expect(persisted.recoveryHashes).toHaveLength(10);
    expect(persisted.recoveryHashes.join()).not.toContain(recoveryCodes[0]!);

    // 动态码登录
    expect(await service.verifyLogin(totpAt(base32Decode(secret), now()))).toBe(true);
    // 恢复码一次性：第一次通过，第二次拒绝
    const recovery = recoveryCodes[0]!;
    expect(await service.verifyLogin(recovery)).toBe(true);
    expect(await service.verifyLogin(recovery)).toBe(false);

    // 重启（重新 load）后凭据仍在，票据清空
    const reloaded = new TotpAuthService(path.join(root, "totp.json"), { now });
    await reloaded.load();
    expect(reloaded.enabled()).toBe(true);
  });

  it("confirm 码错误不落盘；disable 后文件删除且票据吊销", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-totp-"));
    roots.push(root);
    const now = () => 1_700_000_000_000;
    const service = new TotpAuthService(path.join(root, "totp.json"), { now });
    await service.load();
    const { secret } = service.beginSetup();
    expect(await service.confirmSetup("000000")).toBeUndefined();
    expect(service.enabled()).toBe(false);
    expect(await service.confirmSetup(totpAt(base32Decode(secret), now()))).toHaveLength(10);
    const ticket = service.issueTicket();
    expect(service.validateTicket(ticket)).toBe(true);
    expect(await service.disable(totpAt(base32Decode(secret), now()))).toBe(true);
    expect(service.enabled()).toBe(false);
    expect(service.validateTicket(ticket)).toBe(false);
    await expect(stat(path.join(root, "totp.json"))).rejects.toThrow();
  });

  it("票据滑动续期与每 IP 5 次失败锁 60s", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-totp-"));
    roots.push(root);
    let currentTime = 1_700_000_000_000;
    const now = () => currentTime;
    const { service } = await makeEnabledService(root, now);
    const ticket = service.issueTicket();
    // 11.5h 后仍有效（期间有一次有效校验触发滑动续期）
    currentTime += 11.5 * 3_600_000;
    expect(service.validateTicket(ticket)).toBe(true);
    currentTime += 11.5 * 3_600_000;
    expect(service.validateTicket(ticket)).toBe(true);
    // 超过 12h 无活动则过期
    currentTime += 13 * 3_600_000;
    expect(service.validateTicket(ticket)).toBe(false);

    currentTime = 1_800_000_000_000;
    expect(service.loginLockedSeconds("1.2.3.4")).toBe(0);
    for (let index = 0; index < 4; index += 1) service.recordLoginFailure("1.2.3.4");
    expect(service.loginLockedSeconds("1.2.3.4")).toBe(0);
    service.recordLoginFailure("1.2.3.4");
    expect(service.loginLockedSeconds("1.2.3.4")).toBeGreaterThan(0);
    // 锁定期间失败不延长
    service.recordLoginFailure("1.2.3.4");
    expect(service.loginLockedSeconds("1.2.3.4")).toBeLessThanOrEqual(60);
    currentTime += 61_000;
    expect(service.loginLockedSeconds("1.2.3.4")).toBe(0);
    // 锁定到期后 failures 计数保留不清零：下一次失败即累计达到上限重新锁定，
    // 攻击者无法每轮锁定都换到完整的 5 次尝试
    service.recordLoginFailure("1.2.3.4");
    expect(service.loginLockedSeconds("1.2.3.4")).toBeGreaterThan(0);
    // 锁定到期 + 成功登录才真正清零
    currentTime += 61_000;
    expect(service.loginLockedSeconds("1.2.3.4")).toBe(0);
    service.recordLoginFailure("1.2.3.4");
    service.recordLoginSuccess("1.2.3.4");
    service.recordLoginFailure("1.2.3.4");
    expect(service.loginLockedSeconds("1.2.3.4")).toBe(0);
  });
});

async function buildTestApp(root: string, options: { totp?: TotpAuthService; accessToken?: string; listenHost?: string } = {}): Promise<FastifyInstance> {
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  return buildServer({
    core: {} as CoreClient,
    sessions,
    agent: { isRunning: () => false } as AgentRunner,
    events: new EventBus(),
    providers: new ProviderRegistry(),
    pricing,
    ...(options.totp ? { totp: options.totp } : {}),
    ...(options.listenHost !== undefined ? { listenHost: options.listenHost } : {}),
    ...(options.accessToken ? { auth: { accessToken: options.accessToken, allowedOrigins: ["https://owc.example.test"] } } : {}),
  });
}

describe("TOTP 门禁与登录 REST", () => {
  it("默认关闭：门禁完全不生效，status 如实上报", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-totp-"));
    roots.push(root);
    const app = await buildTestApp(root);
    try {
      const status = await app.inject({ method: "GET", url: "/api/auth/status" });
      expect(status.json()).toEqual({
        totpEnabled: false,
        authenticated: true,
        terminalAvailable: false,
        gateReasons: ["totp_disabled"],
      });
      expect((await app.inject({ method: "GET", url: "/api/metrics" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("启用后：无凭据 401、bearer 旁路、cookie 通过、静态与 health/auth 豁免", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-totp-"));
    roots.push(root);
    const now = () => Date.now();
    const { service, secret } = await makeEnabledService(root, now);
    const accessToken = "a".repeat(32);
    const app = await buildTestApp(root, { totp: service, accessToken });
    try {
      // 豁免：health 与 auth 状态匿名可达
      expect((await app.inject({ method: "GET", url: "/api/auth/status" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/" })).statusCode).not.toBe(401);
      // 无凭据：401
      expect((await app.inject({ method: "GET", url: "/api/metrics" })).statusCode).toBe(401);
      // bearer 旁路（cli 通道保留可用）
      expect((await app.inject({ method: "GET", url: "/api/metrics", headers: { authorization: `Bearer ${accessToken}` } })).statusCode).toBe(200);
      // TOTP cookie 通过（含滑动续期 set-cookie）
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { code: totpAt(base32Decode(secret), now()) } });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
      expect(String(login.headers["set-cookie"])).toContain("HttpOnly");
      expect(String(login.headers["set-cookie"])).toContain("SameSite=Lax");
      const gated = await app.inject({ method: "GET", url: "/api/metrics", headers: { cookie } });
      expect(gated.statusCode).toBe(200);
      expect(gated.headers["set-cookie"]).toBeDefined();
      // 登出吊销票据
      expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/metrics", headers: { cookie } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("启用后禁止匿名重 setup/confirm/disable（防顶替）", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-totp-"));
    roots.push(root);
    const now = () => Date.now();
    const { service } = await makeEnabledService(root, now);
    const app = await buildTestApp(root, { totp: service });
    try {
      expect((await app.inject({ method: "POST", url: "/api/auth/totp/setup" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/auth/totp/confirm", payload: { code: "123456" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/auth/totp/disable", payload: { code: "123456" } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("setup→confirm→login→disable 全流程 + 恢复码一次性 + 每 IP 限流锁定", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-totp-"));
    roots.push(root);
    const now = () => Date.now();
    const service = new TotpAuthService(path.join(root, "totp.json"), { now });
    await service.load();
    const app = await buildTestApp(root, { totp: service });
    try {
      // 未启用时登录报错
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { code: "123456" } })).statusCode).toBe(400);
      // setup：拿到暂存 secret 与 otpauth URI，confirm 前不启用
      const setup = await app.inject({ method: "POST", url: "/api/auth/totp/setup" });
      expect(setup.statusCode).toBe(200);
      const { secret, otpauthUrl } = setup.json() as { secret: string; otpauthUrl: string };
      expect(otpauthUrl).toContain("otpauth://totp/");
      expect(otpauthUrl).toContain(`secret=${secret}`);
      expect(service.enabled()).toBe(false);
      // confirm：错误码拒绝，正确码返回 10 个恢复码
      expect((await app.inject({ method: "POST", url: "/api/auth/totp/confirm", payload: { code: "000000" } })).statusCode).toBe(400);
      const confirm = await app.inject({ method: "POST", url: "/api/auth/totp/confirm", payload: { code: totpAt(base32Decode(secret), now()) } });
      expect(confirm.statusCode).toBe(200);
      const { recoveryCodes } = confirm.json() as { recoveryCodes: string[] };
      expect(recoveryCodes).toHaveLength(10);
      // 限流：同 IP 连续 5 次失败锁定 60s
      for (let index = 0; index < 5; index += 1) {
        expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { code: "999999" } })).statusCode).toBe(401);
      }
      const locked = await app.inject({ method: "POST", url: "/api/auth/login", payload: { code: totpAt(base32Decode(secret), now()) } });
      expect(locked.statusCode).toBe(429);
      expect((locked.json() as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
      // 另一个 IP 不受锁定影响（恢复码一次性语义由 TotpAuthService 单测覆盖）
      const otherIpLogin = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.0.0.2", payload: { code: totpAt(base32Decode(secret), now()) } });
      expect(otherIpLogin.statusCode).toBe(200);
      // disable：错误码 400，正确码禁用并清文件，status 回落关闭态
      const cookie = String(otherIpLogin.headers["set-cookie"]).split(";", 1)[0];
      expect((await app.inject({ method: "POST", url: "/api/auth/totp/disable", headers: { cookie }, payload: { code: "000000" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/auth/totp/disable", headers: { cookie }, payload: { code: totpAt(base32Decode(secret), now()) } })).statusCode).toBe(200);
      const status = await app.inject({ method: "GET", url: "/api/auth/status" });
      expect((status.json() as { totpEnabled: boolean }).totpEnabled).toBe(false);
      await expect(stat(path.join(root, "totp.json"))).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it("status 的终端门槛：非回环/局域网监听地址给出 gateReasons", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-totp-"));
    roots.push(root);
    const now = () => Date.now();
    const { service } = await makeEnabledService(root, now);
    const lan = await buildTestApp(root, { totp: service, listenHost: "192.168.1.20" });
    try {
      const status = await lan.inject({ method: "GET", url: "/api/auth/status" });
      expect(status.json()).toMatchObject({ totpEnabled: true, authenticated: false, terminalAvailable: true, gateReasons: [] });
    } finally {
      await lan.close();
    }
    const wildcard = await buildTestApp(root, { totp: service, listenHost: "0.0.0.0" });
    try {
      const status = await wildcard.inject({ method: "GET", url: "/api/auth/status" });
      expect(status.json()).toMatchObject({ terminalAvailable: false, gateReasons: ["host_not_loopback_or_lan"] });
    } finally {
      await wildcard.close();
    }
  });
});
