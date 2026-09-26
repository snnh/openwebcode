import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * chat 分享口令的加盐派生。此前是无盐的单轮 SHA-256：`meta.json` 一旦被读取（备份、
 * 同步目录、误提交），弱口令可离线暴破。改用 scrypt（内存硬）+ 每口令独立盐，
 * 存储为自描述串 `scrypt$<salt hex>$<hash hex>`。
 *
 * 不提供旧格式迁移：无 `scrypt$` 前缀的历史哈希一律判为不匹配，受影响的分
 * 需要重新设置分享口令（分享本身不承载历史数据，重建成本为零）。
 */
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_BYTES = 16;

export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifySharePassword(password: string, stored: string | undefined): Promise<boolean> {
  const [scheme, saltHex, hashHex] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scryptAsync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
