import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
/** 快照 id：snap-<毫秒时间戳>-<6 位随机 hex>，统一校验防路径穿越与参数注入。 */
export function newSnapshotId() {
    return `snap-${Date.now()}-${randomBytes(3).toString("hex")}`;
}
export function validateSnapshotId(id) {
    if (!/^snap-\d+-[0-9a-f]{6}$/.test(id))
        throw new Error("Invalid checkpoint ID");
}
export function isCheckpoint(value) {
    if (!value || typeof value !== "object")
        return false;
    const item = value;
    return typeof item.id === "string" && typeof item.label === "string" && typeof item.createdAt === "string" && Number.isSafeInteger(item.messageCount) && Number(item.messageCount) >= 0;
}
/** 读取 checkpoints.json：文件缺失或内容损坏都按空列表处理（容错）。 */
export async function readCheckpoints(file) {
    try {
        const value = JSON.parse(await readFile(file, "utf8"));
        return Array.isArray(value) ? value.filter(isCheckpoint) : [];
    }
    catch {
        return [];
    }
}
export async function writeCheckpoints(file, checkpoints) {
    await writeFile(file, `${JSON.stringify(checkpoints, null, 2)}\n`, "utf8");
}
/** 简要 diff 文本统一截断到 maxLines 行。 */
export function truncateLines(text, maxLines = 200) {
    const lines = text.split("\n");
    if (lines.length <= maxLines)
        return text;
    return `${lines.slice(0, maxLines).join("\n")}\n…（截断，共 ${lines.length} 行）`;
}
