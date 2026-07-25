import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("GitShadowSnapshots", () => {
  it("restores an empty-tree checkpoint by clearing the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-shadow-empty-")); roots.push(root);
    const workspace = path.join(root, "workspace");
    const session = path.join(root, "session");
    await mkdir(workspace);
    const snapshots = new GitShadowSnapshots(session, workspace);
    const checkpoint = await snapshots.create("empty baseline", 0, { round: 0 });

    await writeFile(path.join(workspace, "later.txt"), "added after the checkpoint", "utf8");
    await snapshots.restore(checkpoint.id);
    await expect(readFile(path.join(workspace, "later.txt"), "utf8")).rejects.toThrow();
  });

  it("captures tracked and untracked files outside the workspace and restores them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-shadow-")); roots.push(root);
    const workspace = path.join(root, "workspace");
    const session = path.join(root, "session");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "a.txt"), "one", "utf8");
    await writeFile(path.join(workspace, "untracked.txt"), "keep", "utf8");
    await writeFile(path.join(workspace, ".gitignore"), "*.cache\n", "utf8");
    await writeFile(path.join(workspace, "saved.cache"), "saved", "utf8");
    const snapshots = new GitShadowSnapshots(session, workspace);
    expect(await snapshots.capability()).toMatchObject({ backend: "git-shadow", requiresAdmin: false });
    const checkpoint = await snapshots.create("before edit", 2, { round: 1 });
    expect(path.dirname(path.join(session, "shadow.git"))).not.toBe(workspace);

    await writeFile(path.join(workspace, "a.txt"), "two", "utf8");
    await rm(path.join(workspace, "untracked.txt"));
    await writeFile(path.join(workspace, "new.txt"), "new", "utf8");
    await writeFile(path.join(workspace, "new.cache"), "ignored", "utf8");
    await writeFile(path.join(workspace, "saved.cache"), "changed", "utf8");
    // 0.5.0 Phase 1b：diff 返回 stat 摘要 + 完整 unified diff（供 Web diff 视图 hunk 解析）
    const diffText = await snapshots.diff(checkpoint.id);
    expect(diffText).toContain("a.txt");
    expect(diffText).toContain("diff --git a/a.txt b/a.txt");
    expect(diffText).toMatch(/@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/);
    expect(diffText).toContain("-one");
    expect(diffText).toContain("+two");
    await snapshots.restore(checkpoint.id);
    const restored = (await snapshots.list()).find((item) => item.id === checkpoint.id);

    expect(restored?.ledger).toEqual({ round: 1 });
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe("keep");
    expect(await readFile(path.join(workspace, "saved.cache"), "utf8")).toBe("saved");
    await expect(readFile(path.join(workspace, "new.cache"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace, "new.txt"), "utf8")).rejects.toThrow();
  });
});
