import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";

/**
 * TOTP 全局登录认证（提交⑥）：RFC 6238（HMAC-SHA1、30s 步长、6 位、±1 窗口），
 * 零第三方依赖（node:crypto）。凭据持久化在 <数据目录>/totp.json（0600），
 * 会话票据与登录限流仅驻留内存——重启即全部重新登录。
 */

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
/** 验证码形态校验（模块级常量，避免每次 verify 重建 RegExp） */
const TOTP_CODE_PATTERN = new RegExp(`^\\d{${TOTP_DIGITS}}$`);
const RECOVERY_CODE_COUNT = 10;
/** 会话票据有效期；每次有效请求滑动重置 */
export const TOTP_TICKET_TTL_MS = 12 * 60 * 60 * 1_000;
/** 每 IP 连续失败次数上限与锁定时长 */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 60_000;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(data: Buffer): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let value = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!;
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** 指定时刻的 TOTP 码（测试与登录校验共用） */
export function totpAt(secret: Buffer, timestampMs: number): string {
  return hotp(secret, Math.floor(timestampMs / 1_000 / TOTP_STEP_SECONDS));
}

export function verifyTotp(secret: Buffer, code: string, timestampMs: number, window = TOTP_WINDOW): boolean {
  const normalized = code.trim();
  if (!TOTP_CODE_PATTERN.test(normalized)) return false;
  const counter = Math.floor(timestampMs / 1_000 / TOTP_STEP_SECONDS);
  const expected = Buffer.from(normalized);
  for (let step = -window; step <= window; step += 1) {
    if (counter + step < 0) continue;
    const candidate = Buffer.from(hotp(secret, counter + step));
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/** 恢复码：10 位十六进制，展示为 xxxxx-xxxxx；存储用 sha256 哈希，一次性用完即删 */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replaceAll("-", "").replaceAll(" ", "");
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code), "utf8").digest("hex");
}

function timingSafeHashEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 终端门槛（提交⑦预埋）的监听地址判定：回环（127.0.0.0/8、::1、localhost）
 * 或局域网字面量（10/8、172.16/12、192.168/16、fe80::/10）。
 * 0.0.0.0 / :: 通配监听对公网可达，一律视为不满足。
 */
export function isLoopbackOrLAN(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized === "0.0.0.0" || normalized === "::") return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (first > 255 || second > 255) return false;
    if (first === 127 || first === 10) return true;
    if (first === 192 && second === 168) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    return false;
  }
  if (normalized.includes(":")) {
    // fe80::/10：首 hextet 落在 fe80..febf
    const firstHextet = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
    return firstHextet >= 0xfe80 && firstHextet <= 0xfebf;
  }
  return false;
}

interface TotpFileState {
  secret: string;
  enabled: boolean;
  recoveryHashes: string[];
}

export interface TotpAuthStatusInput {
  /** 当前监听地址（终端门槛判定用） */
  listenHost: string;
}

export class TotpAuthService {
  private state: TotpFileState | undefined;
  /** setup 生成的暂存 secret，confirm 校验通过前不落 enabled */
  private pendingSecret: string | undefined;
  /** 会话票据表：随机 token → 过期时间；仅内存，重启即重新登录 */
  private readonly tickets = new Map<string, number>();
  /** 登录限流：IP → 连续失败计数与锁定截止 */
  private readonly loginAttempts = new Map<string, { failures: number; lockedUntil: number }>();
  private readonly now: () => number;

  constructor(private readonly filePath: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 启动时加载；文件缺失/未启用视为关闭，不报错 */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<TotpFileState>;
    if (parsed.enabled !== true || typeof parsed.secret !== "string") return;
    this.state = {
      secret: parsed.secret,
      enabled: true,
      recoveryHashes: Array.isArray(parsed.recoveryHashes)
        ? parsed.recoveryHashes.filter((hash): hash is string => typeof hash === "string")
        : [],
    };
  }

  enabled(): boolean {
    return this.state?.enabled === true;
  }

  /** 生成暂存 secret 与 otpauth:// URI；confirm 校验通过前不落盘 enabled */
  beginSetup(): { secret: string; otpauthUrl: string } {
    const secret = base32Encode(randomBytes(20));
    this.pendingSecret = secret;
    const issuer = "OpenWebCode";
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
    return { secret, otpauthUrl };
  }

  /** 校验暂存 secret 的动态码；通过则落盘 enabled 并生成恢复码（明文仅此一次返回） */
  async confirmSetup(code: string): Promise<string[] | undefined> {
    if (this.pendingSecret === undefined) return undefined;
    if (!verifyTotp(base32Decode(this.pendingSecret), code, this.now())) return undefined;
    const recoveryCodes: string[] = [];
    for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
      const hex = randomBytes(5).toString("hex");
      recoveryCodes.push(`${hex.slice(0, 5)}-${hex.slice(5)}`);
    }
    this.state = { secret: this.pendingSecret, enabled: true, recoveryHashes: recoveryCodes.map(hashRecoveryCode) };
    this.pendingSecret = undefined;
    await this.persist();
    return recoveryCodes;
  }

  /** 登录校验：TOTP 动态码或一次性恢复码 */
  async verifyLogin(code: string): Promise<boolean> {
    if (!this.state) return false;
    if (verifyTotp(base32Decode(this.state.secret), code, this.now())) return true;
    return this.consumeRecoveryCode(code);
  }

  /** 验证码后禁用并清除凭据文件与全部票据 */
  async disable(code: string): Promise<boolean> {
    if (!this.state) return false;
    const ok = verifyTotp(base32Decode(this.state.secret), code, this.now()) || (await this.consumeRecoveryCode(code));
    if (!ok) return false;
    this.state = undefined;
    this.pendingSecret = undefined;
    this.tickets.clear();
    await rm(this.filePath, { force: true });
    return true;
  }

  issueTicket(): string {
    this.pruneTickets();
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(token, this.now() + TOTP_TICKET_TTL_MS);
    return token;
  }

  /** 校验票据并滑动续期（每次有效请求重置 12h） */
  validateTicket(token: string | undefined): boolean {
    if (!token || !this.enabled()) return false;
    const expiresAt = this.tickets.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.tickets.delete(token);
      return false;
    }
    this.tickets.set(token, this.now() + TOTP_TICKET_TTL_MS);
    return true;
  }

  revokeTicket(token: string | undefined): void {
    if (token !== undefined) this.tickets.delete(token);
  }

  /** 该 IP 剩余锁定秒数；0 = 未锁定 */
  loginLockedSeconds(ip: string): number {
    const entry = this.loginAttempts.get(ip);
    if (!entry || entry.lockedUntil <= this.now()) return 0;
    return Math.ceil((entry.lockedUntil - this.now()) / 1_000);
  }

  recordLoginFailure(ip: string): void {
    const now = this.now();
    let entry = this.loginAttempts.get(ip);
    if (!entry || entry.lockedUntil > now) {
      // 锁定期间不计数；无记录则新建
      if (entry) return;
      entry = { failures: 0, lockedUntil: 0 };
    }
    entry.failures += 1;
    if (entry.failures >= LOGIN_MAX_FAILURES) {
      entry.lockedUntil = now + LOGIN_LOCK_MS;
      entry.failures = 0;
    }
    this.loginAttempts.set(ip, entry);
  }

  recordLoginSuccess(ip: string): void {
    this.loginAttempts.delete(ip);
  }

  private async consumeRecoveryCode(code: string): Promise<boolean> {
    if (!this.state) return false;
    const hash = hashRecoveryCode(code);
    const index = this.state.recoveryHashes.findIndex((stored) => timingSafeHashEqual(stored, hash));
    if (index < 0) return false;
    // 一次性：用完即删并落盘
    this.state.recoveryHashes.splice(index, 1);
    await this.persist();
    return true;
  }

  private pruneTickets(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(token);
    }
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // 已存在文件 mode 不生效，补一次 chmod（Windows 上尽力而为）
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}
