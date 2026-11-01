import { cp, lstat, mkdir, rename, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";

/**
 * 旧 env-sim 数据目录 → 新 agent-presets 数据目录的一次性、幂等迁移。
 * 迁移完成后在旧路径建一个目录符号链接指向新目录，保留短期兼容
 * （外部脚本/分享预设仍按旧路径读写）。旧路径本就是符号链接时直接跳过。
 */
export async function migrateAgentPresetsDataDir(dataDir: string): Promise<void> {
  const legacyRoot = path.join(dataDir, "env-sim");
  const nextRoot = path.join(dataDir, "agent-presets");
  const legacyPresets = path.join(legacyRoot, "personas");
  const nextPresets = path.join(nextRoot, "presets");

  const legacy = await lstatOrNull(legacyRoot);
  if (legacy && legacy.isSymbolicLink()) return; // 旧路径整体是链接：无需迁移
  if (legacy && (await lstatOrNull(legacyPresets))?.isSymbolicLink() === true) return; // 兼容 shim 已就位

  if (legacy) {
    if (!await exists(nextRoot)) {
      await moveOrCopy(legacyRoot, nextRoot);
    } else {
      // 新旧并存：只导入新目录中不存在的预设，然后清理旧目录。
      await mkdir(nextPresets, { recursive: true });
      if (await exists(legacyPresets)) {
        await cp(legacyPresets, nextPresets, { recursive: true, force: false, errorOnExist: false });
      }
      await rm(legacyRoot, { recursive: true, force: true });
    }
  }

  const legacyInner = path.join(nextRoot, "personas");
  if (await exists(legacyInner)) {
    if (!await exists(nextPresets)) {
      await moveOrCopy(legacyInner, nextPresets);
    } else {
      await cp(legacyInner, nextPresets, { recursive: true, force: false, errorOnExist: false });
      await rm(legacyInner, { recursive: true, force: true });
    }
  }

  await ensureLegacyShim(legacyRoot, nextPresets);
}

async function moveOrCopy(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isCrossDevice(error)) throw error;
    await cp(from, to, { recursive: true, errorOnExist: false });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * 旧路径兼容 shim：`<dataDir>/env-sim/personas` → `<dataDir>/agent-presets/presets` 目录链接。
 * 保留旧路径形态（外部脚本、分享文档仍按 env-sim/personas 读写）。失败（无符号链接权限/
 * 平台不支持）静默忽略，只失去旧路径兼容，功能不受影响。
 */
async function ensureLegacyShim(legacyRoot: string, nextPresets: string): Promise<void> {
  if (!await exists(nextPresets)) return;
  if (await lstatOrNull(path.join(legacyRoot, "personas"))) return;
  try {
    await mkdir(legacyRoot, { recursive: true });
    await symlink(path.resolve(nextPresets), path.join(legacyRoot, "personas"), "junction");
  } catch {
    // 见上：兼容层尽力而为。
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

function isCrossDevice(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EXDEV");
}