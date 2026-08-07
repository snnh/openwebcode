import { afterEach, describe, expect, it, vi } from "vitest";
import { queryWorkspaceFiles } from "../dialogs/QuickOpen";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("Quick Open 数据源", () => {
  it("索引缓存可用时返回索引结果与状态", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/workspaces/files")) return json({ files: [{ path: "src/a.ts" }, { path: "src/b.ts" }], indexStatus: "fresh" });
      return json({ error: "not mocked" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await queryWorkspaceFiles("s1", "a");
    expect(result.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.indexStatus).toBe("fresh");
  });

  it("索引 409/501 回退 complete-path（与 @ 补全同一降级路径）", async () => {
    for (const status of [409, 501]) {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/workspaces/files")) return json({ error: "index not ready" }, status);
        if (url.includes("complete-path")) return json({ matches: [{ path: "fallback/x.ts", kind: "file" }] });
        return json({ error: "not mocked" }, 404);
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = await queryWorkspaceFiles("s1", "x");
      expect(result.paths).toEqual(["fallback/x.ts"]);
      expect(result.indexStatus).toBe("unavailable");
      vi.unstubAllGlobals();
    }
  });

  it("其他错误原样抛出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    await expect(queryWorkspaceFiles("s1", "x")).rejects.toThrow("boom");
  });
});
