import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";

/**
 * 非回环监听的访问令牌自动管理：OWC_ACCESS_TOKEN 显式设置时优先（长度仍强制
 * >= 32）；否则从 <数据目录>/access-token 读取或生成（32 字节随机 hex，0600），
 * 让「设置页改监听地址即可用」在 Windows/Linux 行为一致，不再要求手工环境变量。
 */

export const ACCESS_TOKEN_MIN_LENGTH = 32;

export interface ResolvedAccessToken {
  token: string;
  source: "env" | "generated";
}

/** 生成令牌的持久化形态；文件内容不符时视为损坏并重新生成 */
const GENERATED_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

async function writeToken(filePath: string, token: string): Promise<void> {
  await writeFile(filePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  // 已存在文件 mode 不生效，补一次 chmod（Windows 上尽力而为）
  await chmod(filePath, 0o600).catch(() => undefined);
}

export async function resolveAccessToken(options: { envToken?: string | undefined; filePath: string }): Promise<ResolvedAccessToken> {
  const envToken = options.envToken?.trim();
  if (envToken) {
    if (envToken.length < ACCESS_TOKEN_MIN_LENGTH) {
      throw new Error(`OWC_ACCESS_TOKEN must be at least ${ACCESS_TOKEN_MIN_LENGTH} characters`);
    }
    return { token: envToken, source: "env" };
  }
  let existing: string | undefined;
  try {
    existing = (await readFile(options.filePath, "utf8")).trim();
  } catch {
    existing = undefined;
  }
  if (existing && GENERATED_TOKEN_PATTERN.test(existing)) {
    return { token: existing, source: "generated" };
  }
  const token = randomBytes(32).toString("hex");
  await writeToken(options.filePath, token);
  return { token, source: "generated" };
}

/** 重新生成并持久化；仅 generated 来源可调用（env 显式配置时由用户自行轮换） */
export async function regenerateAccessToken(filePath: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await writeToken(filePath, token);
  return token;
}

/** 非 internal 的 IPv4 地址列表（0.0.0.0/:: 监听时用于拼访问链接） */
export function listLanAddresses(): string[] {
  const result: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) result.push(info.address);
    }
  }
  return result;
}

function bracketHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** 拼带 token 的一键访问链接；通配监听时用 LAN 地址展开，枚举不到则回退通配符本身 */
export function buildAccessUrls(host: string, port: number, lanAddresses: string[], token: string): string[] {
  const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
  const hosts = wildcard ? (lanAddresses.length > 0 ? lanAddresses : [host]) : [host];
  return hosts.map((entry) => `http://${bracketHost(entry)}:${port}/?token=${encodeURIComponent(token)}`);
}
