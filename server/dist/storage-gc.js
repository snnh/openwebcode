import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
/**
 * 会话 artifacts 的全局 LRU 上限（plan §4：默认 2GB）。
 * 只清理 sessions/<id>/artifacts 下的驱逐产物——它们由账本条目引用，
 * 超限后从最旧开始删除，read_artifact 对被删条目将返回不存在。
 */
export class StorageGC {
    sessionsRoot;
    maxBytes;
    constructor(sessionsRoot, maxBytes) {
        this.sessionsRoot = sessionsRoot;
        this.maxBytes = maxBytes;
    }
    setMaxBytes(value) {
        this.maxBytes = value;
    }
    get limit() {
        return this.maxBytes;
    }
    async collect() {
        const files = await this.scan();
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        const report = { scanned: files.length, removed: 0, freedBytes: 0, totalBytes, maxBytes: this.maxBytes };
        if (totalBytes <= this.maxBytes)
            return report;
        const byAge = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
        let remaining = totalBytes;
        for (const file of byAge) {
            if (remaining <= this.maxBytes)
                break;
            try {
                await rm(file.filePath, { force: true });
                remaining -= file.size;
                report.removed += 1;
                report.freedBytes += file.size;
            }
            catch {
                // 单个文件删除失败不阻断整体清理
            }
        }
        report.totalBytes = remaining;
        return report;
    }
    async scan() {
        const files = [];
        let sessions = [];
        try {
            sessions = await readdir(this.sessionsRoot);
        }
        catch {
            return files;
        }
        for (const sessionId of sessions) {
            const artifactsDir = path.join(this.sessionsRoot, sessionId, "artifacts");
            let names;
            try {
                names = await readdir(artifactsDir);
            }
            catch {
                continue;
            }
            for (const name of names) {
                const filePath = path.join(artifactsDir, name);
                try {
                    const info = await stat(filePath);
                    if (info.isFile())
                        files.push({ filePath, size: info.size, mtimeMs: info.mtimeMs });
                }
                catch {
                    // 扫描期间被删除的文件直接跳过
                }
            }
        }
        return files;
    }
}
