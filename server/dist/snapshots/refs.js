import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newSnapshotId, readCheckpoints, truncateLines, validateSnapshotId, writeCheckpoints, } from "./backend.js";
/** refs-clone.ps1 的资产路径（src 与 dist 下均位于 server/<src|dist>/snapshots，向上两级即 server/）。 */
export function refsScriptPath() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "refs-clone.ps1");
}
/** Windows ReFS 块克隆快照（经 refs-clone.ps1 调用 FSCTL_DUPLICATE_EXTENTS，失败时脚本内回落普通拷贝）。 */
export class RefsBackend {
    sessionRoot;
    workspace;
    runner;
    name = "refs";
    snapRoot;
    metadataPath;
    constructor(sessionRoot, workspace, runner) {
        this.sessionRoot = sessionRoot;
        this.workspace = workspace;
        this.runner = runner;
        this.snapRoot = path.join(sessionRoot, "refs-snaps");
        this.metadataPath = path.join(sessionRoot, "checkpoints.json");
    }
    async initialize() {
        await mkdir(this.snapRoot, { recursive: true });
    }
    async capability() {
        return { backend: "refs", costHint: "instant", requiresAdmin: false, detail: "ReFS 块克隆" };
    }
    async create(label, messageCount, ledger) {
        await this.initialize();
        const id = newSnapshotId();
        await this.runScript("create", path.join(this.snapRoot, id));
        const checkpoint = { id, label, createdAt: new Date().toISOString(), messageCount, ...(ledger === undefined ? {} : { ledger }) };
        const checkpoints = await this.list();
        checkpoints.push(checkpoint);
        await writeCheckpoints(this.metadataPath, checkpoints);
        return checkpoint;
    }
    async list() {
        return readCheckpoints(this.metadataPath);
    }
    async diff(id) {
        validateSnapshotId(id);
        const before = await walkFiles(path.join(this.snapRoot, id));
        const after = await walkFiles(this.workspace);
        const lines = [];
        for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort()) {
            const snap = before.get(relative);
            const work = after.get(relative);
            if (snap && !work)
                lines.push(`D ${relative}`);
            else if (!snap && work)
                lines.push(`A ${relative}`);
            else if (snap && work && (snap.size !== work.size || snap.mtimeMs !== work.mtimeMs))
                lines.push(`M ${relative}`);
        }
        return truncateLines(lines.join("\n"));
    }
    async restore(id) {
        validateSnapshotId(id);
        if (!(await this.list()).some((item) => item.id === id))
            throw new Error("Checkpoint not found");
        await this.runScript("restore", path.join(this.snapRoot, id));
    }
    async delete(id) {
        validateSnapshotId(id);
        await this.runScript("delete", path.join(this.snapRoot, id));
        await writeCheckpoints(this.metadataPath, (await this.list()).filter((item) => item.id !== id));
    }
    async runScript(mode, snapDir) {
        const result = await this.runner.run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", refsScriptPath(), "-Mode", mode, "-Workspace", this.workspace, "-SnapDir", snapDir], { timeoutMs: 600_000 });
        if (result.code !== 0)
            throw new Error(`refs-clone ${mode} failed (${result.code})`);
    }
}
/** 递归收集 相对路径 → {size, mtimeMs}；目录不存在视为空。 */
async function walkFiles(root) {
    const files = new Map();
    const visit = async (relative) => {
        let entries;
        try {
            entries = await readdir(path.join(root, relative), { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await visit(child);
                continue;
            }
            if (!entry.isFile())
                continue;
            const info = await stat(path.join(root, child));
            files.set(child, { size: info.size, mtimeMs: info.mtimeMs });
        }
    };
    await visit("");
    return files;
}
