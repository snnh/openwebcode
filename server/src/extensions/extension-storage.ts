import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** 扩展私有存储配额缺省值：单文件 1 MiB、目录总量 50 MiB；调用方可用 deps.storageQuota 覆盖。 */
const STORAGE_FILE_LIMIT = 1024 * 1024;
const STORAGE_TOTAL_LIMIT = 50 * 1024 * 1024;

export interface StorageQuota {
  file: number;
  total: number;
}

/** 扩展私有存储根：<dataDir>/extensions-data/<extensionId>/。无需权限——私有目录天然隔离。 */
export function storageRoot(dataDir: string, extensionId: string): string {
  return path.join(dataDir, "extensions-data", extensionId);
}

/** 相对路径解析：禁绝对路径、禁 .. 逃逸，规范化后必须仍在扩展自己的目录内。 */
function storagePath(root: string, relative: string): string {
  // Windows 绝对形态（盘符/UNC）必须在所有宿主 OS 上拒绝：
  // POSIX 的 path.isAbsolute("C:/x") 为 false，会在私有目录里静默造出 "C:" 目录。
  if (!relative || path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith("\\\\")) {
    throw new Error("storage path must be a non-empty relative path");
  }
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("storage path escapes the extension directory");
  return resolved;
}

/**
 * 单个扩展的私有存储。读写都在 root-bound 路径内，写前做单文件与目录总量配额检查。
 * 无状态（根目录与配额在构造时固定），管理器按调用创建即可。
 */
export class ExtensionStorage {
  private readonly fileLimit: number;
  private readonly totalLimit: number;

  constructor(private readonly root: string, quota?: Partial<StorageQuota>) {
    this.fileLimit = quota?.file ?? STORAGE_FILE_LIMIT;
    this.totalLimit = quota?.total ?? STORAGE_TOTAL_LIMIT;
  }

  async read(relative: string): Promise<{ content: string | null }> {
    const target = storagePath(this.root, relative);
    try {
      const info = await stat(target);
      if (!info.isFile()) return { content: null };
      return { content: await readFile(target, "utf8") };
    } catch {
      return { content: null };
    }
  }

  async write(relative: string, content: unknown): Promise<{ bytes: number }> {
    if (typeof content !== "string") throw new Error("storage.write content must be a string");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.fileLimit) throw new Error(`storage.write exceeds the per-file limit of ${this.fileLimit} bytes`);
    const target = storagePath(this.root, relative);
    const existing = await stat(target).catch(() => undefined);
    const total = await this.usage();
    const next = total - (existing?.isFile() ? existing.size : 0) + bytes;
    if (next > this.totalLimit) throw new Error(`storage.write exceeds the total quota of ${this.totalLimit} bytes`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return { bytes };
  }

  async delete(relative: string): Promise<{ deleted: boolean }> {
    const target = storagePath(this.root, relative);
    const existing = await stat(target).catch(() => undefined);
    if (!existing) return { deleted: false };
    await rm(target, { recursive: existing.isDirectory(), force: true });
    return { deleted: true };
  }

  async list(prefix: string): Promise<{ files: string[] }> {
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) files.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    await walk(this.root);
    files.sort();
    return { files: prefix ? files.filter((file) => file.startsWith(prefix)) : files };
  }

  /** 目录总量（递归求和），供写前配额统计。 */
  async usage(): Promise<number> {
    let total = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) total += (await stat(full)).size;
      }
    };
    await walk(this.root);
    return total;
  }
}
