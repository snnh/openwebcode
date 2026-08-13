import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getOfficialUserAgent } from "./user-agent.js";
import { compareSemver, stripVersionPrefix } from "./update-checker.js";

/** 在线更新的状态机状态。restarting 表示服务即将退出（由安装程序或 systemd 接管）。 */
export interface UpdateApplyState {
  status: "idle" | "downloading" | "verifying" | "applying" | "restarting" | "done" | "error";
  /** 目标版本（无 v 前缀） */
  version: string;
  /** 下载进度 0..1；content-length 未知时为 null */
  progress: number | null;
  /** 面向用户的中性描述 */
  message: string;
  error?: string;
  /** ISO 时间戳 */
  startedAt: string;
}

/** 语义化错误：路由层按 statusCode 映射 400/409 等响应码。 */
export class UpdateApplyError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "UpdateApplyError";
  }
}

export interface UpdateApplierOptions {
  /** 业务数据目录；更新包下载到 <dataDir>/updates/<version>/ */
  dataDir: string;
  /** 安装根目录（OWC_HOME）；dist 下运行时为 path.resolve(server/dist, "../..") */
  installRoot: string;
  /** 注入以便测试；缺省 process.platform */
  platform?: NodeJS.Platform;
  /** 注入以便测试；缺省 process.arch（Linux 资产名按架构映射：x64/arm64/loongarch64） */
  arch?: string;
  getReleaseUrl: () => string;
  getCurrentVersion: () => string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  /** 退出当前进程（默认延迟 800ms 让 202 响应先发出）；测试注入为空操作 */
  exitImpl?: () => void;
  /** 注入以便测试；缺省 process.getuid（非 POSIX 平台视为 -1） */
  getuidImpl?: () => number;
  /** 注入以便测试；缺省 /etc/systemd/system/openwebcode.service */
  systemUnitPath?: string;
  now?: () => Date;
}

/** 单个资产大小上限（含一定余量）；超限直接拒绝。 */
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const RELEASE_JSON_TIMEOUT_MS = 15_000;

interface ReleaseAsset {
  name: string;
  url: string;
}

/**
 * WebUI 在线更新（Windows/Linux）。流程：查询 GitHub Releases → 下载资产 +
 * SHA256SUMS → 校验哈希 → 按平台应用（Windows 交给 msiexec 退出后替换；
 * Linux 解压 tar.gz 直接覆盖 installRoot，有 systemd unit（系统级/用户级）
 * 则自动重启）。
 * 状态纯内存保存，供 GET 查询；进程退出后丢失属预期。
 */
export class UpdateApplier {
  private currentState: UpdateApplyState | undefined;
  private inFlight: Promise<UpdateApplyState> | undefined;

  constructor(private readonly options: UpdateApplierOptions) {}

  /** 当前/最近一次更新状态；从未执行过返回 null。 */
  state(): UpdateApplyState | null {
    return this.currentState ? { ...this.currentState } : null;
  }

  /** 主流程。互斥：已有进行中的更新时抛 409 语义错误。 */
  apply(): Promise<UpdateApplyState> {
    if (this.inFlight) {
      return Promise.reject(new UpdateApplyError(409, "已有进行中的更新"));
    }
    const promise = this.run();
    this.inFlight = promise;
    return promise.finally(() => {
      this.inFlight = undefined;
    });
  }

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private get arch(): string {
    return this.options.arch ?? process.arch;
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch;
  }

  private get spawnImpl(): typeof spawn {
    return this.options.spawnImpl ?? spawn;
  }

  private get exitImpl(): () => void {
    return this.options.exitImpl ?? (() => {
      setTimeout(() => process.exit(0), 800).unref();
    });
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private setState(patch: Partial<UpdateApplyState>): void {
    if (!this.currentState) return;
    this.currentState = { ...this.currentState, ...patch };
  }

  private async run(): Promise<UpdateApplyState> {
    try {
      return await this.runInner();
    } catch (error) {
      // 版本获取/版本判断阶段的错误发生在状态建立之前，不覆盖内存状态
      if (this.currentState) {
        const message = error instanceof Error ? error.message : String(error);
        this.setState({ status: "error", message, error: message });
      }
      throw error;
    }
  }

  private async runInner(): Promise<UpdateApplyState> {
    const release = await this.fetchRelease();
    const version = stripVersionPrefix(release.tag);
    if (!version) throw new Error("GitHub 响应缺少 tag_name");
    if (compareSemver(version, this.options.getCurrentVersion()) <= 0) {
      throw new UpdateApplyError(400, "已是最新版本");
    }
    const platform = this.platform;
    if (platform !== "win32" && platform !== "linux") {
      throw new UpdateApplyError(400, "当前平台不支持在线更新");
    }
    let assetName: string;
    if (platform === "win32") {
      assetName = `openwebcode-${version}-windows-x64.msi`;
    } else {
      // Linux 资产按架构区分（release.yml 矩阵产物）：aarch64 机器误下 x64 包会变砖
      const archMap: Record<string, string> = { x64: "x64", arm64: "arm64", loong64: "loongarch64" };
      const linuxArch = archMap[this.arch];
      if (!linuxArch) throw new UpdateApplyError(400, `当前架构不支持在线更新: ${this.arch}`);
      assetName = `openwebcode-${version}-linux-${linuxArch}.tar.gz`;
    }
    const asset = release.assets.find((entry) => entry.name === assetName);
    if (!asset) throw new Error(`发布中未找到资产 ${assetName}`);
    const sums = release.assets.find((entry) => entry.name === "SHA256SUMS.txt");
    if (!sums) throw new Error("发布中未找到 SHA256SUMS.txt");
    assertGithubAssetUrl(asset.url);
    assertGithubAssetUrl(sums.url);

    this.currentState = {
      status: "downloading",
      version,
      progress: null,
      message: `正在下载 ${version} 更新包`,
      startedAt: this.now().toISOString(),
    };

    const updateDir = path.join(this.options.dataDir, "updates", version);
    await mkdir(updateDir, { recursive: true });
    const assetPath = path.join(updateDir, assetName);
    await this.download(asset.url, assetPath);

    this.setState({ status: "verifying", progress: null, message: "正在校验更新包" });
    const sumsText = await this.fetchText(sums.url);
    const expectedHash = parseSumsHash(sumsText, assetName);
    const actualHash = await sha256File(assetPath);
    if (actualHash !== expectedHash) {
      await rm(assetPath, { force: true }).catch(() => undefined);
      throw new Error("更新包 SHA256 校验不匹配，已删除下载文件");
    }

    this.setState({ status: "applying", message: "正在应用更新" });
    if (platform === "win32") {
      // MSI 需先退出本进程再替换被锁文件：分离 cmd 延迟 3 秒后启动 msiexec
      const child = this.spawnImpl("cmd.exe", ["/c", `timeout /t 3 /nobreak >nul & msiexec /i "${assetPath}" /passive /norestart`], { detached: true, stdio: "ignore" });
      child.unref();
      this.setState({ status: "restarting", message: "安装程序已启动，服务即将退出并应用更新" });
      this.exitImpl();
      return this.state()!;
    }
    await this.applyLinux(assetPath, updateDir);
    return this.state()!;
  }

  private async applyLinux(archivePath: string, updateDir: string): Promise<void> {
    const installRoot = this.options.installRoot;
    try {
      await access(installRoot, fsConstants.W_OK);
    } catch {
      throw new Error("安装目录不可写；请改用 packaging/install-online.sh 更新（可能需要 sudo）");
    }
    const extractDir = path.join(updateDir, "extract");
    // 解压前先列条目，拒绝绝对路径与 .. 穿越，保证解压 root-bound
    const listing = await this.runCommand("tar", ["-tzf", archivePath]);
    if (listing.code !== 0) throw new Error(`无法读取更新包（tar 退出码 ${listing.code}）`);
    for (const line of listing.stdout.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry) continue;
      if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry) || entry.split("/").includes("..")) {
        throw new Error("更新包包含不安全路径，已中止");
      }
    }
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    const extract = await this.runCommand("tar", ["-xzf", archivePath, "-C", extractDir]);
    if (extract.code !== 0) throw new Error(`更新包解压失败（tar 退出码 ${extract.code}）`);
    if (!existsSync(path.join(extractDir, "server", "dist", "index.js"))) {
      throw new Error("更新包内容不完整：缺少 server/dist/index.js");
    }
    // 程序文件无用户数据，逐项 force 覆盖即可；install.sh 仅手动安装使用，不复制
    for (const entry of await readdir(extractDir, { withFileTypes: true })) {
      if (entry.name === "install.sh") continue;
      await cp(path.join(extractDir, entry.name), path.join(installRoot, entry.name), { recursive: true, force: true });
    }
    // 有 systemd unit 则延迟 1 秒自动重启（先让 202 响应发出）；否则提示手动重启。
    // 关键时序：unit 配置为 Restart=on-failure，本进程 clean exit 不会被拉起；
    // try-restart 对 inactive 服务又是 no-op——两种时序下更新后服务都会停在
    // down。因此一律用 restart（对 inactive 服务同样会启动），覆盖
    // “先 restart 后退出”与“先退出后 restart”两种顺序。
    // 系统级安装（root 经 install.sh --system 安装）下 server 进程即 root，
    // 直接 systemctl restart；否则按用户级 unit 处理。
    // 启动器 <prefix>/bin/owc 位于 installRoot（<prefix>/lib/openwebcode）之外，
    // 本次覆盖更新不影响启动器及其中端口/数据目录等默认变量。
    const configHome = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
    const userUnitPath = path.join(configHome, "systemd", "user", "openwebcode.service");
    const systemUnitPath = this.options.systemUnitPath ?? "/etc/systemd/system/openwebcode.service";
    const getuid = this.options.getuidImpl ?? (() => (typeof process.getuid === "function" ? process.getuid() : -1));
    let restartCommand: string | null = null;
    if (getuid() === 0 && existsSync(systemUnitPath)) {
      restartCommand = "systemctl restart openwebcode.service";
    } else if (existsSync(userUnitPath)) {
      restartCommand = "systemctl --user restart openwebcode.service";
    }
    if (restartCommand) {
      const child = this.spawnImpl("sh", ["-c", `sleep 1; ${restartCommand}`], { detached: true, stdio: "ignore" });
      child.unref();
      this.setState({ status: "restarting", message: "更新已应用，服务将自动重启" });
      this.exitImpl();
    } else {
      this.setState({ status: "done", message: "更新已应用，请手动重启服务生效" });
    }
  }

  private async fetchRelease(): Promise<{ tag: string; assets: ReleaseAsset[] }> {
    const response = await this.fetchImpl(this.options.getReleaseUrl(), {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": getOfficialUserAgent(),
      },
      signal: AbortSignal.timeout(RELEASE_JSON_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`获取版本信息失败：HTTP ${response.status}`);
    const body = await response.json() as { tag_name?: unknown; assets?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    const assets: ReleaseAsset[] = [];
    if (Array.isArray(body.assets)) {
      for (const entry of body.assets) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.name === "string" && typeof record.browser_download_url === "string") {
          assets.push({ name: record.name, url: record.browser_download_url });
        }
      }
    }
    return { tag, assets };
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": getOfficialUserAgent() },
      signal: AbortSignal.timeout(RELEASE_JSON_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    return response.text();
  }

  /** 流式下载到 <target>.part 完成后 rename；按 content-length 更新进度，超限中止。 */
  private async download(url: string, targetPath: string): Promise<void> {
    const response = await this.fetchImpl(url, { headers: { "User-Agent": getOfficialUserAgent() } });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    if (!response.body) throw new Error("下载失败：响应无内容");
    const lengthHeader = response.headers.get("content-length");
    const total = lengthHeader ? Number(lengthHeader) : null;
    if (total !== null && (!Number.isFinite(total) || total < 0)) throw new Error("下载失败：content-length 非法");
    if (total !== null && total > MAX_ASSET_BYTES) throw new Error("更新包超过 1 GiB 大小限制");
    this.setState({ progress: total !== null && total > 0 ? 0 : null });
    const partPath = `${targetPath}.part`;
    let received = 0;
    const source = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_ASSET_BYTES) {
        source.destroy(new Error("更新包超过 1 GiB 大小限制"));
        return;
      }
      if (total !== null && total > 0) this.setState({ progress: received / total });
    });
    try {
      await pipeline(source, createWriteStream(partPath));
      await rename(partPath, targetPath);
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** 运行命令并收集 stdout，校验退出码由调用方负责。 */
  private runCommand(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }
}

/** 只允许 github.com 的 https 资产 URL，防止被污染的 release 数据引导到任意外站。 */
function assertGithubAssetUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UpdateApplyError(400, "更新资产 URL 非法");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new UpdateApplyError(400, "更新资产 URL 非 github.com，拒绝下载");
  }
}

/** 从 SHA256SUMS.txt 中解析目标资产对应的十六进制哈希。 */
function parseSumsHash(text: string, assetName: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === assetName) return match[1]!.toLowerCase();
  }
  throw new Error("SHA256SUMS.txt 中未找到目标资产条目");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}
