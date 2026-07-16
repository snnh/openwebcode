import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitShadowSnapshots } from "../src/snapshots/git-shadow.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("GitShadowSnapshots", () => {
  it("captures tracked and untracked files outside the workspace and restores them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-shadow-")); roots.push(root);
    const workspace = path.join(root, "workspace");
    const session = path.join(root, "session");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
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
    expect(await snapshots.diff(checkpoint.id)).toContain("a.txt");
    const restored = await snapshots.restore(checkpoint.id);

    expect(restored.ledger).toEqual({ round: 1 });
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe("keep");
    expect(await readFile(path.join(workspace, "saved.cache"), "utf8")).toBe("saved");
    await expect(readFile(path.join(workspace, "new.cache"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace, "new.txt"), "utf8")).rejects.toThrow();
  });
});
