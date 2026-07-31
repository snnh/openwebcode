import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareSemver, stripVersionPrefix, UpdateChecker } from "../src/update-checker.js";
import { setServerVersion } from "../src/version.js";
import { tempRoot } from "./helpers/temp-roots.js";

afterEach(() => setServerVersion("0.0.0"));

function githubResponse(tag: string): Response {
  return new Response(JSON.stringify({
    tag_name: tag,
    html_url: `https://github.com/snnh/openwebcode/releases/tag/${tag}`,
    published_at: "2026-07-27T00:00:00Z",
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("semver helpers", () => {
  it("compares versions numerically", () => {
    expect(compareSemver("0.5.3", "0.5.2")).toBeGreaterThan(0);
    expect(compareSemver("0.5.2", "0.5.2")).toBe(0);
    expect(compareSemver("0.5.2", "0.6.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("strips a leading v from tags", () => {
    expect(stripVersionPrefix("v0.5.2")).toBe("0.5.2");
    expect(stripVersionPrefix("0.5.2")).toBe("0.5.2");
  });
});

describe("UpdateChecker", () => {
  it("does not fetch when disabled", async () => {
    const root = await tempRoot("owc-update-");
    let calls = 0;
    const checker = new UpdateChecker({
      cachePath: path.join(root, "update-check.json"),
      defaultUrl: "https://api.github.com/repos/snnh/openwebcode/releases/latest",
      fetchImpl: async () => { calls += 1; return githubResponse("v9.9.9"); },
    });
    checker.configure({ enabled: false, intervalHours: 24 });
    await checker.initialize();
    const snapshot = await checker.refresh();
    expect(calls).toBe(0);
    expect(snapshot).toBeUndefined();
    checker.close();
  });

  it("reports a newer release and caches it", async () => {
    const root = await tempRoot("owc-update-");
    setServerVersion("0.5.2");
    let calls = 0;
    const cachePath = path.join(root, "update-check.json");
    const checker = new UpdateChecker({
      cachePath,
      defaultUrl: "https://api.github.com/repos/snnh/openwebcode/releases/latest",
      fetchImpl: async () => { calls += 1; return githubResponse("v0.6.0"); },
    });
    checker.configure({ enabled: true, intervalHours: 24 });
    await checker.initialize();
    const snapshot = checker.current();
    expect(calls).toBe(1);
    expect(snapshot?.latestVersion).toBe("0.6.0");
    expect(snapshot?.isNewer).toBe(true);
    expect(snapshot?.htmlUrl).toContain("v0.6.0");

    // 节流：间隔内再次 refresh 不重新请求
    await checker.refresh();
    expect(calls).toBe(1);
    checker.close();

    // 缓存可被新实例读取
    const reloaded = new UpdateChecker({
      cachePath,
      defaultUrl: "https://api.github.com/repos/snnh/openwebcode/releases/latest",
      fetchImpl: async () => { calls += 1; return githubResponse("v0.6.0"); },
    });
    reloaded.configure({ enabled: false, intervalHours: 24 });
    await reloaded.initialize();
    expect(reloaded.current()?.latestVersion).toBe("0.6.0");
    expect(calls).toBe(1);
    reloaded.close();
  });

  it("marks same version as not newer", async () => {
    const root = await tempRoot("owc-update-");
    setServerVersion("0.5.2");
    const checker = new UpdateChecker({
      cachePath: path.join(root, "update-check.json"),
      defaultUrl: "https://api.github.com/repos/snnh/openwebcode/releases/latest",
      fetchImpl: async () => githubResponse("v0.5.2"),
    });
    checker.configure({ enabled: true, intervalHours: 24 });
    await checker.initialize();
    expect(checker.current()?.isNewer).toBe(false);
    checker.close();
  });
});
