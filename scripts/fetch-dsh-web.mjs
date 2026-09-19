#!/usr/bin/env node
/**
 * dsh SPA vendor 脚本：把钉版 dsh 前端产物抓到 `server/assets/dsh-web/`（不进 git）。
 *
 * 产物布局：
 *   <out>/manifest.json                    清单（供 server 运行时生成 boot graph）
 *   <out>/static/**                        前端 dist（index.html + assets/fonts/langs）
 *   <out>/plugins/<id>/client.js           各 client 插件 bundle（已含包内分块）
 *   <out>/licenses/<id>.txt                各包 LICENSE（许可合规）
 *
 * 用法：
 *   node scripts/fetch-dsh-web.mjs                        # 默认版本 → 默认目录
 *   node scripts/fetch-dsh-web.mjs --version 0.1.6-alpha.2
 *   node scripts/fetch-dsh-web.mjs --only @deepseek-ai/dsh-client-modules,@deepseek-ai/dsh-client-ui-chat
 *   node scripts/fetch-dsh-web.mjs --skip-frontend --out /tmp/dsh-web
 *
 * 说明：直接走 registry tarball（不跑 npm install / 不解析依赖树），无第三方依赖；
 * 组件来源 = `@deepseek-ai/dsh-web-app@<ver>` 的 cordis.patch.yml roster ∩ `dsh.client.platform === "web"`。
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 钉版 dsh UI 版本（唯一来源；变更需同步 docs/dsh-protocol-map.md 的协议复核结论）。 */
export const DSH_UI_VERSION = "0.1.6-alpha.2";

/** 默认 vendor 目录（相对仓库根）。 */
export const DSH_VENDOR_DIR = "server/assets/dsh-web";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 前端 dist 所在包。 */
const FRONTEND_PACKAGE = "@deepseek-ai/dsh-web-frontend";
/** roster 推导源包（其 cordis.patch.yml 列出整套 host/client 插件）。 */
const ROSTER_PACKAGE = "@deepseek-ai/dsh-web-app";
/** 模块系统自身（bootstrap batch 的唯一成员，必须存在）。 */
const MODULES_PACKAGE = "@deepseek-ai/dsh-client-modules";

function parseArgs(argv) {
  const options = { version: DSH_UI_VERSION, out: DSH_VENDOR_DIR, registry: "https://registry.npmjs.org", only: undefined, skipFrontend: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--version" && value) { options.version = value; index++; continue; }
    if (flag === "--out" && value) { options.out = value; index++; continue; }
    if (flag === "--registry" && value) { options.registry = value.replace(/\/+$/, ""); index++; continue; }
    if (flag === "--only" && value) { options.only = new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean)); index++; continue; }
    if (flag === "--skip-frontend") { options.skipFrontend = true; continue; }
    if (flag === "--help" || flag === "-h") { options.help = true; continue; }
    throw new Error(`未知参数：${flag}`);
  }
  return options;
}

function tarballUrl(registry, name, version) {
  const base = name.startsWith("@") ? name.slice(1) : name;
  const slash = base.indexOf("/");
  const scope = base.slice(0, slash);
  const bare = base.slice(slash + 1);
  return `${registry}/@${scope}%2f${bare}/-/${bare}-${version}.tgz`;
}

/** 最小 tar 读取器：支持 ustar + pax 长路径（npm tarball），只返回普通文件内容。 */
function readTarEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  let paxPath;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(text(124, 12), 8) || 0;
    const type = text(156, 1);
    const name = text(0, 100);
    const prefix = text(345, 155);
    const body = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "x") {
      // pax 扩展头：只取 path 覆盖（npm 用长路径时出现）
      const record = body.toString("utf8");
      const match = /^\d+ path=([^\n]*)\n/m.exec(record);
      if (match) paxPath = match[1];
      continue;
    }
    if (type !== "0" && type !== "" && type !== "\0") continue;
    const full = paxPath ?? (prefix === "" ? name : `${prefix}/${name}`);
    paxPath = undefined;
    entries.set(full, body);
  }
  return entries;
}

/** 带退避重试的 fetch（registry 偶发 5xx/连接重置时不要整体失败）。 */
async function fetchWithRetry(url, init, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError ?? new Error("fetch failed");
}

/** 取包的 packument（versions + dist-tags；纯 JSON，缓存到 .cache/）。 */
async function fetchPackument(registry, name, cacheDirectory) {
  const base = name.startsWith("@") ? name.slice(1) : name;
  const slash = base.indexOf("/");
  const url = `${registry}/@${base.slice(0, slash)}%2f${base.slice(slash + 1)}`;
  const cacheFile = path.join(cacheDirectory, `packument_${name.replace(/[@/]/g, "_")}.json`);
  const cached = await readFile(cacheFile, "utf8").catch(() => undefined);
  if (cached !== undefined) return JSON.parse(cached);
  const response = await fetchWithRetry(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`读取 packument 失败 ${name}：HTTP ${response.status} ${url}`);
  const text = await response.text();
  await writeOut(cacheFile, text);
  return JSON.parse(text);
}

/**
 * 在 packument 里挑选落进声明范围的版本。
 *
 * 只做本场景够用的匹配：精确钉版直接用；`^`/`~`/`>=` 取「同 major.minor.patch 前缀」的最高版本
 * （先正式版、再预发布）。dsh 生态各包独立发版（如 `@deepseek-ai/schemastery@3.18.x`），
 * 不能一律按 web-app 的版本取。取不到就回落 dist-tags.latest。
 */
function pickVersion(packument, range) {
  const versions = Object.keys(packument.versions ?? {});
  if (versions.length === 0) return packument["dist-tags"]?.latest;
  const cleaned = String(range ?? "").replace(/^[\^~>=<\s]+/, "");
  if (versions.includes(cleaned)) return cleaned;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (match !== null) {
    const prefix = `${match[1]}.${match[2]}.${match[3]}`;
    const samePrefix = versions.filter((version) => version === prefix || version.startsWith(`${prefix}-`));
    const stable = samePrefix.filter((version) => !version.includes("-"));
    if (stable.length > 0) return stable.sort().at(-1);
    if (samePrefix.length > 0) return samePrefix.sort().at(-1);
    const sameMinor = versions.filter((version) => version.startsWith(`${match[1]}.${match[2]}.`));
    if (sameMinor.length > 0) return sameMinor.sort().at(-1);
  }
  return packument["dist-tags"]?.latest ?? versions.sort().at(-1);
}

/**
 * dsh 前端插件 roster：从 `@deepseek-ai/dsh-web-app` 出发做 `@deepseek-ai/*` 依赖闭包遍历。
 *
 * 为什么不用 cordis.patch.yml：那张表只列该 app 显式 patch 的服务，会漏掉「只被其它包以
 * `external` 引用」的客户端插件（实测漏了 `@deepseek-ai/dsh-api-gateway`——它提供 WS 连接与
 * `ctx.remote`，漏装即 SPA 启动失败）。这里按 registry packument 的依赖声明递归（dependencies
 * + peerDependencies），逐包用声明范围挑版本；`dsh.client.platform === "web"` 者即为插件。
 * patch.yml 作为补充来源。
 */
async function resolveRoster(registry, rootName, rootVersion, cacheDirectory) {
  const packuments = new Map();
  const versions = new Map();
  const pending = [[rootName, rootVersion]];
  const seen = new Set([rootName]);
  while (pending.length > 0) {
    const [name, range] = pending.shift();
    let packument = packuments.get(name);
    if (packument === undefined) {
      try {
        packument = await fetchPackument(registry, name, cacheDirectory);
      } catch (error) {
        // 单个依赖取不到元数据（下架/网络抖动）不应中断整体：如实跳过并记一行
        console.warn(`  跳过 ${name}：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      packuments.set(name, packument);
    }
    const version = name === rootName ? rootVersion : pickVersion(packument, range);
    const manifest = version === undefined ? undefined : packument.versions?.[version];
    if (manifest === undefined) continue;
    versions.set(name, version);
    // dependencies + peerDependencies：npm 7+ 会自动安装 peer，dsh 的客户端插件正是以
    // peer 形式互相引用（如 controller → `@deepseek-ai/dsh-api-gateway`），只走 dependencies 会漏装
    const declared = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) };
    for (const [dependency, dependencyRange] of Object.entries(declared)) {
      if (!dependency.startsWith("@deepseek-ai/") || seen.has(dependency)) continue;
      seen.add(dependency);
      pending.push([dependency, dependencyRange]);
    }
  }
  const webPlugins = [];
  for (const [name, version] of versions) {
    if (packuments.get(name)?.versions?.[version]?.dsh?.client?.platform === "web") webPlugins.push(name);
  }
  return { packuments, versions, webPlugins };
}

async function fetchTarball(registry, name, version, cacheDirectory) {
  const cacheFile = path.join(cacheDirectory, `${name.replace(/[@/]/g, "_")}-${version}.tgz`);
  if (cacheDirectory !== undefined) {
    const cached = await readFile(cacheFile).catch(() => undefined);
    if (cached !== undefined) return readTarEntries(gunzipSync(cached));
  }
  const url = tarballUrl(registry, name, version);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${name}@${version}：HTTP ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (cacheDirectory !== undefined) await writeOut(cacheFile, bytes);
  return readTarEntries(gunzipSync(bytes));
}

/** roster → 包名：cordis.patch.yml 里可能写服务子路径（`@scope/pkg/service`），取包名部分。 */
function packageNameOf(entry) {
  const segments = entry.split("/");
  return entry.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/** 版本区间内的 roster（cordis.patch.yml 的 `name:` 行，保持文件顺序）。 */
function parseRoster(text) {
  const names = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:-\s+)?name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (!match) continue;
    const name = packageNameOf(match[1]);
    if (name.startsWith("@deepseek-ai/") && !names.includes(name)) names.push(name);
  }
  return names;
}

function sha1Short(buffer) {
  return createHash("sha1").update(buffer).digest("hex").slice(0, 12);
}

async function readJson(entries, member) {
  const body = entries.get(member);
  if (body === undefined) throw new Error(`tarball 缺少 ${member}`);
  return JSON.parse(body.toString("utf8"));
}

function stringList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

/** 写文件（自动建目录）。 */
/** 展示用路径：仓库内用相对路径，仓库外保留绝对路径。 */
function display(target) {
  const relative = path.relative(REPO_ROOT, target);
  return relative === "" || relative.startsWith("..") ? target : relative;
}

async function writeOut(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：node scripts/fetch-dsh-web.mjs [--version <ver>] [--out <dir>] [--registry <url>] [--only <pkg,...>] [--skip-frontend]`);
    return;
  }
  const out = path.resolve(REPO_ROOT, options.out);
  console.log(`dsh UI vendor：version=${options.version} out=${display(out)}`);

  const cacheDirectory = path.join(out, ".cache");
  const rosterEntries = await fetchTarball(options.registry, ROSTER_PACKAGE, options.version, cacheDirectory);
  const patchRoster = parseRoster(rosterEntries.get("package/cordis.patch.yml")?.toString("utf8") ?? "");
  const closure = await resolveRoster(options.registry, ROSTER_PACKAGE, options.version, cacheDirectory);
  console.log(`roster：依赖闭包 ${closure.versions.size} 个包（其中 ${closure.webPlugins.length} 个声明 dsh.client.platform=web）+ patch.yml ${patchRoster.length} 个补充候选`);

  // 插件候选 = 闭包内 web 插件 ∪ patch.yml 名单（后者可能含闭包外的包）
  const webPluginSet = new Set(closure.webPlugins);
  const candidates = [...new Set([...webPluginSet, ...patchRoster, MODULES_PACKAGE])]
    .filter((name) => options.only === undefined || options.only.has(name));
  const plugins = [];
  for (const name of candidates) {
    // 闭包内已知非 web 插件的包直接跳过（省一次 tarball 下载）
    const resolvedVersion = closure.versions.get(name);
    const known = resolvedVersion === undefined ? undefined : closure.packuments.get(name)?.versions?.[resolvedVersion];
    if (known !== undefined && known.dsh?.client?.platform !== "web" && !webPluginSet.has(name)) continue;
    const entries = await fetchTarball(options.registry, name, resolvedVersion ?? options.version, cacheDirectory);
    const pkg = await readJson(entries, "package/package.json");
    const declaration = pkg.dsh?.client;
    if (declaration?.platform !== "web") continue;
    const files = [];
    for (const [member, body] of entries) {
      if (!member.startsWith("package/lib/") || member.includes("/types/") || !member.endsWith(".js")) continue;
      const relative = member.slice("package/lib/".length);
      files.push({ relative, body });
    }
    const entry = files.find((file) => file.relative === "client.js");
    if (entry === undefined) throw new Error(`${name} 声明了 dsh.client 但 tarball 内没有 lib/client.js`);
    const directory = path.join(out, "plugins", name);
    for (const file of files) await writeOut(path.join(directory, file.relative), file.body);
    const license = entries.get("package/LICENSE") ?? entries.get("package/LICENSE.md") ?? entries.get("package/LICENSE.txt");
    if (license !== undefined) {
      await writeOut(path.join(out, "licenses", `${name.replace(/[@/]/g, "_")}.txt`), license);
    }
    plugins.push({
      id: name,
      version: typeof pkg.version === "string" ? pkg.version : options.version,
      rev: sha1Short(entry.body),
      entry: "client.js",
      files: files.map((file) => file.relative).sort(),
      ...(declaration.immediately === true ? { immediately: true } : {}),
      inject: stringList(declaration.inject),
      external: stringList(declaration.external),
    });
    process.stdout.write(`  + ${name} (${files.length} 个文件, rev=${sha1Short(entry.body)})\n`);
  }
  if (plugins.length === 0) throw new Error("没有任何包声明 dsh.client.platform === \"web\"（roster 解析或 --only 过滤有误？）");
  plugins.sort((left, right) => left.id.localeCompare(right.id));

  const frontend = { files: 0, rev: "" };
  if (!options.skipFrontend) {
    const entries = await fetchTarball(options.registry, FRONTEND_PACKAGE, options.version, cacheDirectory);
    const staticDirectory = path.join(out, "static");
    for (const [member, body] of entries) {
      if (!member.startsWith("package/dist/")) continue;
      const relative = member.slice("package/dist/".length);
      if (relative === "") continue;
      await writeOut(path.join(staticDirectory, relative), body);
      frontend.files++;
    }
    const index = entries.get("package/dist/index.html");
    if (index === undefined) throw new Error(`${FRONTEND_PACKAGE} 缺少 dist/index.html`);
    frontend.rev = sha1Short(index);
    const license = entries.get("package/LICENSE") ?? entries.get("package/LICENSE.md");
    if (license !== undefined) await writeOut(path.join(out, "licenses", "frontend.txt"), license);
    console.log(`  + ${FRONTEND_PACKAGE}（${frontend.files} 个静态文件）`);
  }

  const manifest = {
    version: 1,
    dshVersion: options.version,
    registry: options.registry,
    generatedAt: new Date().toISOString(),
    frontend,
    plugins,
  };
  await writeOut(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const notices = [
    "# THIRD_PARTY_NOTICES — dsh UI vendor",
    "",
    `本目录由 \`scripts/fetch-dsh-web.mjs\` 生成（dsh 版本 ${options.version}，来源 ${options.registry}）。`,
    "dsh 以 MIT 许可发布；各包完整许可文本见同目录 licenses/。",
    "",
    "| 包 | 版本 |",
    "| --- | --- |",
    ...plugins.map((plugin) => `| ${plugin.id} | ${plugin.version} |`),
    `| ${FRONTEND_PACKAGE} | ${options.version} |`,
    "",
  ].join("\n");
  await writeOut(path.join(out, "THIRD_PARTY_NOTICES.md"), notices);
  console.log(`完成：${plugins.length} 个插件 + 前端 → ${display(out)}`);
}

main().catch((error) => {
  console.error(`fetch-dsh-web 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
