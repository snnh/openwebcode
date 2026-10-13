/**
 * dsh-sync M3b（会话映射表）单测：map.json 的读写往返、宽松降级、upsert 与 LRU 裁剪。
 *
 * 假 storage 是内存字典（只实现 storageRead/storageWrite/storageDelete 三件套），
 * 因此本文件不碰磁盘、不起 Extension Host。
 */
import { describe, expect, it } from "vitest";
import {
  DSH_SYNC_MAP_LIMIT,
  DSH_SYNC_MAP_PATH,
  emptySyncMap,
  findByDshId,
  findByOwcId,
  loadSyncMap,
  recordSync,
  saveSyncMap,
  type DshSyncMapEntry,
  type DshSyncStorageApi,
} from "../src/extensions/dsh-sync-map.js";

/** 内存假 storage（记录写次数，便于断言「没写就不该有写」）。 */
interface FakeStorage {
  api: DshSyncStorageApi;
  files: Map<string, string>;
  writes: number;
}

/** 建内存假 storage；seed 为初始文件内容。 */
function fakeStorage(seed?: { path: string; content: string }): FakeStorage {
  const files = new Map<string, string>();
  if (seed) files.set(seed.path, seed.content);
  const state: FakeStorage = {
    files,
    writes: 0,
    api: {
      storageRead: async (filePath) => ({ content: files.get(filePath) ?? null }),
      storageWrite: async (filePath, content) => {
        files.set(filePath, content);
        state.writes += 1;
        return { bytes: Buffer.byteLength(content, "utf8") };
      },
      storageDelete: async (filePath) => ({ deleted: files.delete(filePath) }),
    },
  };
  return state;
}

/** 造一条映射条目（默认 import 方向）。 */
function entry(dshId: string, owcId: string, lastSyncAt: string, extra: Partial<DshSyncMapEntry> = {}): DshSyncMapEntry {
  return { dshId, owcId, lastSyncDirection: "import", lastSyncAt, ...extra };
}

describe("loadSyncMap / saveSyncMap", () => {
  it("文件缺失（content=null）→ 空表，且不产生写盘", async () => {
    const storage = fakeStorage();
    expect(await loadSyncMap(storage.api)).toEqual({ version: 1, entries: [] });
    expect(storage.writes).toBe(0);
    expect(storage.files.size).toBe(0);
  });

  it("保存后可原样读回（缩进 2 空格的 JSON + 尾换行）", async () => {
    const storage = fakeStorage();
    const map = { version: 1 as const, entries: [entry("dsh-1", "owc-1", "2026-01-01T00:00:00.000Z", { cwd: "/tmp/a", title: "标题" })] };
    await saveSyncMap(storage.api, map);
    const raw = storage.files.get(DSH_SYNC_MAP_PATH) ?? "";
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "entries"');
    expect(await loadSyncMap(storage.api)).toEqual(map);
  });

  it("JSON 损坏 / 顶层结构不符 → 一律降级为空表（不抛）", async () => {
    const broken = fakeStorage({ path: DSH_SYNC_MAP_PATH, content: "{not json" });
    expect(await loadSyncMap(broken.api)).toEqual({ version: 1, entries: [] });

    const wrongShape = fakeStorage({ path: DSH_SYNC_MAP_PATH, content: JSON.stringify({ version: 1, entries: {} }) });
    expect(await loadSyncMap(wrongShape.api)).toEqual({ version: 1, entries: [] });
  });

  it("storage 调用失败（IPC/配额）→ 抛出（与「没同步过」区分，由调用方降级）", async () => {
    const failing: DshSyncStorageApi = {
      storageRead: () => Promise.reject(new Error("storage unavailable")),
      storageWrite: () => Promise.reject(new Error("storage unavailable")),
      storageDelete: () => Promise.reject(new Error("storage unavailable")),
    };
    await expect(loadSyncMap(failing)).rejects.toThrow(/读取会话映射表失败：storage unavailable/);
  });

  it("坏条目逐条丢弃，保留可用条目（dshId/owcId/方向/时间缺一不可）", async () => {
    const storage = fakeStorage({
      path: DSH_SYNC_MAP_PATH,
      content: JSON.stringify({
        version: 1,
        entries: [
          { dshId: "ok", owcId: "owc-ok", lastSyncDirection: "import", lastSyncAt: "2026-01-01T00:00:00.000Z" },
          { dshId: "", owcId: "x", lastSyncDirection: "import", lastSyncAt: "2026-01-01T00:00:00.000Z" },
          { dshId: "no-owc", lastSyncDirection: "import", lastSyncAt: "2026-01-01T00:00:00.000Z" },
          { dshId: "bad-dir", owcId: "y", lastSyncDirection: "sideways", lastSyncAt: "2026-01-01T00:00:00.000Z" },
          { dshId: "no-time", owcId: "z", lastSyncDirection: "export" },
          "not an object",
          42,
        ],
      }),
    });
    const map = await loadSyncMap(storage.api);
    expect(map.entries).toEqual([{ dshId: "ok", owcId: "owc-ok", lastSyncDirection: "import", lastSyncAt: "2026-01-01T00:00:00.000Z" }]);
  });

  it("emptySyncMap 每次返回新对象（调用方改了不串味）", () => {
    const first = emptySyncMap();
    first.entries.push(entry("a", "b", "2026-01-01T00:00:00.000Z"));
    expect(emptySyncMap().entries).toEqual([]);
  });
});

describe("findByDshId / findByOwcId", () => {
  const map = {
    version: 1 as const,
    entries: [
      entry("dsh-1", "owc-1", "2026-01-01T00:00:00.000Z"),
      entry("dsh-2", "owc-2", "2026-01-02T00:00:00.000Z"),
      entry("dsh-3", "owc-2", "2026-01-03T00:00:00.000Z", { lastSyncDirection: "export" }),
    ],
  };

  it("按 dshId 精确命中；未命中 undefined", () => {
    expect(findByDshId(map, "dsh-2")?.owcId).toBe("owc-2");
    expect(findByDshId(map, "dsh-nope")).toBeUndefined();
  });

  it("按 owcId 命中时取最近同步的一条（同一 owc 会话被多次导入的极端情形）", () => {
    expect(findByOwcId(map, "owc-2")).toEqual(map.entries[2]);
    expect(findByOwcId(map, "owc-1")?.dshId).toBe("dsh-1");
    expect(findByOwcId(map, "owc-nope")).toBeUndefined();
  });
});

describe("recordSync（upsert + LRU 裁剪）", () => {
  it("新条目按 lastSyncAt 降序插入（最新在前）", () => {
    let map = emptySyncMap();
    map = recordSync(map, entry("dsh-a", "owc-a", "2026-01-01T00:00:00.000Z"));
    map = recordSync(map, entry("dsh-b", "owc-b", "2026-01-03T00:00:00.000Z"));
    map = recordSync(map, entry("dsh-c", "owc-c", "2026-01-02T00:00:00.000Z"));
    expect(map.entries.map((item) => item.dshId)).toEqual(["dsh-b", "dsh-c", "dsh-a"]);
  });

  it("同一 dshId 再同步 → 原地更新（不新增条目），方向与新给的字段生效", () => {
    let map = recordSync(emptySyncMap(), entry("dsh-a", "owc-a", "2026-01-01T00:00:00.000Z", { cwd: "/tmp/a", title: "旧标题" }));
    map = recordSync(map, {
      dshId: "dsh-a",
      owcId: "owc-a2",
      lastSyncDirection: "export",
      lastSyncAt: "2026-01-05T00:00:00.000Z",
      title: "新标题",
    });
    expect(map.entries).toHaveLength(1);
    expect(map.entries[0]).toEqual({
      dshId: "dsh-a",
      owcId: "owc-a2",
      cwd: "/tmp/a",
      title: "新标题",
      lastSyncDirection: "export",
      lastSyncAt: "2026-01-05T00:00:00.000Z",
    });
  });

  it("纯函数：不改入参", () => {
    const original = emptySyncMap();
    const next = recordSync(original, entry("dsh-a", "owc-a", "2026-01-01T00:00:00.000Z"));
    expect(original.entries).toEqual([]);
    expect(next.entries).toHaveLength(1);
  });

  it("超过上限按 lastSyncAt 最旧裁剪，长度恒为 1000", () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    let map = emptySyncMap();
    for (let index = 0; index < DSH_SYNC_MAP_LIMIT; index += 1) {
      map = recordSync(map, entry(`dsh-${index}`, `owc-${index}`, new Date(base + index * 1000).toISOString()));
    }
    expect(map.entries).toHaveLength(DSH_SYNC_MAP_LIMIT);
    expect(map.entries[0]?.dshId).toBe(`dsh-${DSH_SYNC_MAP_LIMIT - 1}`);

    // 再记一条最新：老的最旧条目（dsh-0）被裁掉，最新的排在最前
    map = recordSync(map, entry("dsh-new", "owc-new", new Date(base + 10_000_000).toISOString()));
    expect(map.entries).toHaveLength(DSH_SYNC_MAP_LIMIT);
    expect(map.entries[0]?.dshId).toBe("dsh-new");
    expect(findByDshId(map, "dsh-0")).toBeUndefined();
    expect(findByDshId(map, "dsh-1")).toBeDefined();
  });

  it("时间串非法时排到最后且不参与「最新」判定（口径确定，可复现）", () => {
    let map = recordSync(emptySyncMap(), entry("dsh-bad", "owc-bad", "not-a-date"));
    map = recordSync(map, entry("dsh-good", "owc-good", "2026-01-01T00:00:00.000Z"));
    expect(map.entries.map((item) => item.dshId)).toEqual(["dsh-good", "dsh-bad"]);
  });
});
