#!/usr/bin/env node
/**
 * 清理已下线的 dsh 兼容模式残留（显式执行，默认只打印计划，不删除）。
 *
 * 删除范围：
 *   - <prefix>/lib/openwebcode/server/assets/dsh-web（Linux 安装树）
 *   - <prefix>/server/assets/dsh-web（Windows/MSI 安装树）
 *   - 同上两处的 dsh-bridge
 *   - <dataDir>/dsh-plugins、<dataDir>/dsh.json
 *   - <dataDir>/server-settings.json 中的 dshCompatEnabled/dshPort/dshUiPath
 *
 * 不删除旧设置里的 dshUiPath 指向的自选 UI 目录，只打印路径提示。
 */
import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SETTING_KEYS = ["dshCompatEnabled", "dshPort", "dshUiPath"];

function usage() {
  output.write(`用法: node scripts/purge-dsh-compat.mjs [options]

  --prefix <dir>     安装前缀；提供后清理其中的 dsh-web/dsh-bridge 受管资产
  --data-dir <dir>   数据目录；默认为平台默认的 openwebcode 数据目录
  --yes              不询问，直接执行
  --dry-run          只打印将删除/修改的路径
  -h, --help         显示本帮助

示例:
  node scripts/purge-dsh-compat.mjs --prefix /usr/local --data-dir /var/lib/openwebcode --yes
  node scripts/purge-dsh-compat.mjs --data-dir "$HOME/openwebcode" --dry-run
`);
}

function parseArgs(argv) {
  const options = { yes: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--prefix" || arg === "--data-dir") {
      const value = argv[index + 1];
      if (value === undefined || value === "") throw new Error(`${arg} 需要一个目录参数`);
      if (arg === "--prefix") options.prefix = value;
      else options.dataDir = value;
      index += 1;
    } else if (arg.startsWith("--prefix=")) options.prefix = arg.slice("--prefix=".length);
    else if (arg.startsWith("--data-dir=")) options.dataDir = arg.slice("--data-dir=".length);
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function defaultDataDir() {
  if (process.env.OWC_DATA_DIR) return process.env.OWC_DATA_DIR;
  if (process.platform === "win32") return path.join(homedir(), "openwebcode");
  if (typeof process.getuid === "function" && process.getuid() === 0) return "/var/lib/openwebcode";
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "openwebcode");
}

function absoluteDirectory(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径: ${value}`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`${label} 不能是文件系统根目录`);
  return resolved;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function readSettings(settingsPath) {
  let raw;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
}

async function stripSettings(settingsPath, dryRun, log) {
  const document = await readSettings(settingsPath);
  if (!document || !document.overrides || typeof document.overrides !== "object" || Array.isArray(document.overrides)) {
    log(`设置文件无 dsh 覆盖项: ${settingsPath}`);
    return false;
  }
  const overrides = document.overrides;
  const present = SETTING_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(overrides, key));
  if (present.length === 0) {
    log(`设置文件无 dsh 覆盖项: ${settingsPath}`);
    return false;
  }
  const customUiPath = typeof overrides.dshUiPath === "string" && overrides.dshUiPath.trim() !== "" ? overrides.dshUiPath.trim() : undefined;
  if (customUiPath) log(`保留自选 dsh UI 目录（未删除）: ${customUiPath}`);
  for (const key of SETTING_KEYS) delete overrides[key];
  log(`${dryRun ? "[dry-run] 将清理" : "清理"}设置项 ${present.join(", ")}: ${settingsPath}`);
  if (!dryRun) {
    await writeFile(settingsPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await chmod(settingsPath, 0o600).catch(() => undefined);
  }
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  const dataDir = absoluteDirectory(options.dataDir || defaultDataDir(), "data-dir");
  const prefix = options.prefix === undefined ? undefined : absoluteDirectory(options.prefix, "prefix");

  const targets = [];
  if (prefix) {
    for (const relative of [
      ["lib", "openwebcode", "server", "assets", "dsh-web"],
      ["lib", "openwebcode", "server", "assets", "dsh-bridge"],
      ["server", "assets", "dsh-web"],
      ["server", "assets", "dsh-bridge"],
    ]) {
      const target = path.join(prefix, ...relative);
      if (isInside(target, prefix)) targets.push({ target, label: "安装资产" });
    }
  }
  const pluginDir = path.join(dataDir, "dsh-plugins");
  const pluginConfig = path.join(dataDir, "dsh.json");
  if (isInside(pluginDir, dataDir)) targets.push({ target: pluginDir, label: "用户插件目录" });
  if (isInside(pluginConfig, dataDir)) targets.push({ target: pluginConfig, label: "用户插件配置" });

  const uniqueTargets = [...new Map(targets.map((entry) => [entry.target, entry])).values()];
  const existing = [];
  for (const entry of uniqueTargets) {
    if (await exists(entry.target)) existing.push(entry);
  }
  const settingsPath = path.join(dataDir, "server-settings.json");
  const settingsExists = await exists(settingsPath);

  output.write(`数据目录: ${dataDir}\n`);
  if (prefix) output.write(`安装前缀: ${prefix}\n`);
  else output.write("安装前缀: 未指定（跳过安装目录资产）\n");
  if (existing.length === 0 && !settingsExists) {
    output.write("没有发现 dsh 兼容模式残留。\n");
    return 0;
  }
  for (const entry of existing) output.write(`- ${entry.label}: ${entry.target}\n`);
  if (settingsExists) output.write(`- 设置文件: ${settingsPath}\n`);
  if (options.dryRun) {
    output.write("dry-run：未删除任何文件。\n");
    if (settingsExists) await stripSettings(settingsPath, true, (line) => output.write(`${line}\n`));
    return 0;
  }
  if (!options.yes) {
    if (!input.isTTY || !output.isTTY) throw new Error("非交互环境必须显式传 --yes");
    const prompt = createInterface({ input, output });
    const answer = (await prompt.question("确认删除以上路径并清理设置项？[y/N] ")).trim().toLowerCase();
    prompt.close();
    if (answer !== "y" && answer !== "yes") {
      output.write("已取消。\n");
      return 1;
    }
  }
  for (const entry of existing) {
    await rm(entry.target, { recursive: true, force: true });
    output.write(`已删除${entry.label}: ${entry.target}\n`);
  }
  if (settingsExists) await stripSettings(settingsPath, false, (line) => output.write(`${line}\n`));
  output.write("dsh 兼容模式残留清理完成。\n");
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`purge-dsh-compat: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
