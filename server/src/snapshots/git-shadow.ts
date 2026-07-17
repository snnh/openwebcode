import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isCheckpoint, type Checkpoint, type SnapshotBackend } from "./backend.js";

export type { Checkpoint } from "./backend.js";

export class GitShadowSnapshots implements SnapshotBackend {
  readonly name = "git-shadow";
  private readonly gitDir: string;
  private readonly metadataPath: string;
  private excludes = [".git", "node_modules", ".owc", ".openwebcode"];
  private static readonly MAX_FILES = 100_000;
  private static readonly MAX_BYTES = 2 * 1024 * 1024 * 1024;

  constructor(private readonly sessionRoot: string, private readonly workspace: string) {
    this.gitDir = path.join(sessionRoot, "shadow.git");
    this.metadataPath = path.join(sessionRoot, "checkpoints.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
    try { await readFile(path.join(this.gitDir, "HEAD"), "utf8"); }
    catch { await this.git(["init", "--bare", this.gitDir], false); }
    const sessionRelative = path.relative(this.workspace, this.sessionRoot);
    if (sessionRelative && !sessionRelative.startsWith("..") && !path.isAbsolute(sessionRelative)) {
      const topLevel = sessionRelative.split(/[\\/]/, 1)[0];
      if (topLevel && !this.excludes.includes(topLevel)) this.excludes = [...this.excludes, topLevel];
    }
    await writeFile(path.join(this.gitDir, "info", "exclude"), `${this.excludes.map((item) => `${item}/`).join("\n")}\n`, "utf8");
  }

  async capability(): Promise<{ backend: "git-shadow"; costHint: "linear"; requiresAdmin: false }> {
    await this.git(["--version"], false);
    return { backend: "git-shadow", costHint: "linear", requiresAdmin: false };
  }

  async create(label: string, messageCount: number, ledger?: unknown): Promise<Checkpoint> {
    await this.initialize();
    const files = await this.scanWorkspace();
    await this.git(["add", "-u"]);
    for (let index = 0; index < files.length; index += 200) await this.git(["add", "-f", "--", ...files.slice(index, index + 200)]);
    await this.git(["commit", "--allow-empty", "-m", label], true);
    const id = (await this.git(["rev-parse", "HEAD"])).trim();
    const checkpoint: Checkpoint = { id, label, createdAt: new Date().toISOString(), messageCount, ...(ledger === undefined ? {} : { ledger }) };
    const checkpoints = await this.list();
    checkpoints.push(checkpoint);
    await this.save(checkpoints);
    return checkpoint;
  }

  async list(): Promise<Checkpoint[]> {
    try {
      const value = JSON.parse(await readFile(this.metadataPath, "utf8")) as unknown;
      return Array.isArray(value) ? value.filter(isCheckpoint) : [];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async diff(id: string): Promise<string> {
    validateId(id);
    return this.git(["diff", "--stat", id]);
  }

  async restore(id: string): Promise<void> {
    validateId(id);
    await this.initialize();
    if (!(await this.list()).some((item) => item.id === id)) throw new Error("Checkpoint not found");
    await this.git(["checkout", "-f", id, "--", "."]);
    await this.git(["clean", "-fdx", ...this.excludes.flatMap((item) => ["-e", `${item}/`])], false);
  }

  async delete(id: string): Promise<void> {
    validateId(id);
    const checkpoints = await this.list();
    await this.save(checkpoints.filter((item) => item.id !== id));
  }

  async cleanup(): Promise<void> { await rm(this.gitDir, { recursive: true, force: true }); }

  private async scanWorkspace(): Promise<string[]> {
    const files: string[] = [];
    let bytes = 0;
    const visit = async (relative: string): Promise<void> => {
      const entries = await readdir(path.join(this.workspace, relative), { withFileTypes: true });
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (this.excludes.some((excluded) => child === excluded || child.startsWith(`${excluded}/`))) continue;
        const stat = await lstat(path.join(this.workspace, child));
        if (stat.isDirectory() && !stat.isSymbolicLink()) { await visit(child); continue; }
        files.push(child); bytes += stat.size;
        if (files.length > GitShadowSnapshots.MAX_FILES) throw new Error(`Checkpoint exceeds ${GitShadowSnapshots.MAX_FILES} files`);
        if (bytes > GitShadowSnapshots.MAX_BYTES) throw new Error(`Checkpoint exceeds ${GitShadowSnapshots.MAX_BYTES} bytes`);
      }
    };
    await visit("");
    return files;
  }

  private git(args: string[], commit = false): Promise<string> {
    const command = args[0] === "init" || args[0] === "--version" ? args : ["--git-dir", this.gitDir, "--work-tree", this.workspace, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn("git", command, {
        cwd: this.workspace,
        windowsHide: true,
        env: commit ? { ...process.env, GIT_AUTHOR_NAME: "OpenWebCode", GIT_AUTHOR_EMAIL: "openwebcode@localhost", GIT_COMMITTER_NAME: "OpenWebCode", GIT_COMMITTER_EMAIL: "openwebcode@localhost" } : process.env,
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`)));
    });
  }

  private async save(checkpoints: Checkpoint[]): Promise<void> {
    await writeFile(this.metadataPath, `${JSON.stringify(checkpoints, null, 2)}\n`, "utf8");
  }
}

function validateId(id: string): void { if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error("Invalid checkpoint ID"); }
