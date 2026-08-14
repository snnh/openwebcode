import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyManagedWorkspaceSync,
  createManagedWorkspaceSyncBaseline,
  managedWorkspaceSyncBaselinePath,
  previewManagedWorkspaceSync,
  type ManagedWorkspaceSyncRoots,
} from "../src/snapshots/managed-sync.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function fixture(): Promise<ManagedWorkspaceSyncRoots> {
  const root = await tempRoot("owc-managed-sync-");
  const originCwd = path.join(root, "origin");
  const workspaceRoot = path.join(root, "workspaces", "sync-session");
  const mountPoint = path.join(root, "mnt", "sync-session");
  await Promise.all([mkdir(originCwd, { recursive: true }), mkdir(workspaceRoot, { recursive: true }), mkdir(mountPoint, { recursive: true })]);
  return { sessionId: "sync-session", originCwd, workspaceRoot, mountPoint };
}

async function put(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function copyInitial(roots: ManagedWorkspaceSyncRoots, relativePath: string, content: string): Promise<void> {
  await Promise.all([put(roots.originCwd, relativePath, content), put(roots.mountPoint, relativePath, content)]);
}

/** fixture + 两侧各放一个 file.txt + 建立基线，供需要既有基线的用例复用。 */
async function baselineFixture(): Promise<ManagedWorkspaceSyncRoots> {
  const roots = await fixture();
  await copyInitial(roots, "file.txt", "base");
  await createManagedWorkspaceSyncBaseline(roots);
  return roots;
}

describe("managed workspace sync-back", () => {
  it("stores the initial baseline outside the mounted cwd and applies only managed-only changes", async () => {
    const roots = await fixture();
    await Promise.all([
      copyInitial(roots, "safe.txt", "base"),
      copyInitial(roots, "origin-only.txt", "base"),
      copyInitial(roots, "conflict.txt", "base"),
      copyInitial(roots, "deleted.txt", "base"),
    ]);
    await createManagedWorkspaceSyncBaseline(roots);
    await expect(readFile(managedWorkspaceSyncBaselinePath(roots.workspaceRoot), "utf8")).resolves.toContain('"sessionId":"sync-session"');
    await expect(readFile(path.join(roots.mountPoint, "sync-baseline.json"), "utf8")).rejects.toThrow();

    await Promise.all([
      put(roots.mountPoint, "safe.txt", "managed change"),
      put(roots.originCwd, "origin-only.txt", "external source change"),
      put(roots.mountPoint, "conflict.txt", "managed conflict"),
      put(roots.originCwd, "conflict.txt", "source conflict"),
      rm(path.join(roots.mountPoint, "deleted.txt")),
      put(roots.mountPoint, "nested/new.txt", "new managed file"),
    ]);

    const preview = await previewManagedWorkspaceSync(roots);
    expect(preview.baseline).toMatchObject({ available: true, version: 1 });
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.scanned).toMatchObject({ origin: { files: 4, bytes: expect.any(Number) }, managed: { files: 4, directories: 1, bytes: expect.any(Number) } });
    const byPath = new Map(preview.changes.map((change) => [change.path, change]));
    expect(byPath.get("safe.txt")).toMatchObject({ action: "update", reason: "managed_changed_only" });
    expect(byPath.get("nested/new.txt")).toMatchObject({ action: "create" });
    expect(byPath.get("nested")).toMatchObject({ action: "unsupported", reason: "non_regular_entry" });
    expect(byPath.get("deleted.txt")).toMatchObject({ action: "delete" });
    expect(byPath.get("origin-only.txt")).toMatchObject({ action: "none", reason: "origin_changed_only" });
    expect(byPath.get("conflict.txt")).toMatchObject({ action: "conflict", reason: "both_changed" });

    const applied = await applyManagedWorkspaceSync(roots, { confirm: true, previewFingerprint: preview.fingerprint! });
    expect(applied.applied).toEqual(expect.arrayContaining([
      { path: "safe.txt", action: "update" },
      { path: "nested/new.txt", action: "create" },
      { path: "deleted.txt", action: "delete" },
    ]));
    await expect(readFile(path.join(roots.originCwd, "safe.txt"), "utf8")).resolves.toBe("managed change");
    await expect(readFile(path.join(roots.originCwd, "nested", "new.txt"), "utf8")).resolves.toBe("new managed file");
    await expect(readFile(path.join(roots.originCwd, "deleted.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(roots.originCwd, "origin-only.txt"), "utf8")).resolves.toBe("external source change");
    await expect(readFile(path.join(roots.originCwd, "conflict.txt"), "utf8")).resolves.toBe("source conflict");
    expect(applied.nextPreview.changes.find((change) => change.path === "conflict.txt")).toMatchObject({ action: "conflict" });

    // 已成功回写的路径推进基线，下一次预览不会把它们误判为双方都改过。
    const next = await previewManagedWorkspaceSync(roots);
    expect(next.changes.some((change) => ["safe.txt", "nested", "nested/new.txt", "deleted.txt"].includes(change.path))).toBe(false);
  });

  it("recomputes the fingerprint before apply and refuses a stale source tree", async () => {
    const roots = await baselineFixture();
    await put(roots.mountPoint, "file.txt", "managed");
    const preview = await previewManagedWorkspaceSync(roots);
    await put(roots.originCwd, "file.txt", "external after preview");

    await expect(applyManagedWorkspaceSync(roots, { confirm: true, previewFingerprint: preview.fingerprint! })).rejects.toMatchObject({ code: "stale_preview" });
    await expect(readFile(path.join(roots.originCwd, "file.txt"), "utf8")).resolves.toBe("external after preview");
  });

  it("honors a cancellation signal before scanning or writing", async () => {
    const roots = await baselineFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(applyManagedWorkspaceSync(roots, { confirm: true, previewFingerprint: "0".repeat(64) }, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("legacy session exposes all differences as conflicts and requires explicit overwriteConflicts", async () => {
    const roots = await fixture();
    await Promise.all([put(roots.originCwd, "file.txt", "origin"), put(roots.mountPoint, "file.txt", "managed")]);
    const preview = await previewManagedWorkspaceSync(roots);
    expect(preview.baseline).toEqual({ available: false, reason: "missing" });
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.changes).toEqual([expect.objectContaining({ path: "file.txt", action: "conflict", reason: "legacy_no_baseline" })]);

    await expect(applyManagedWorkspaceSync(roots, { confirm: true, previewFingerprint: preview.fingerprint! })).rejects.toMatchObject({ code: "baseline_missing" });
    const applied = await applyManagedWorkspaceSync(roots, { confirm: true, previewFingerprint: preview.fingerprint!, overwriteConflicts: true });
    expect(applied.applied).toEqual([{ path: "file.txt", action: "overwrite" }]);
    await expect(readFile(path.join(roots.originCwd, "file.txt"), "utf8")).resolves.toBe("managed");
    expect(applied.nextPreview.baseline.available).toBe(true);
  });

  it("binds the sidecar to the session and source root identity", async () => {
    const roots = await baselineFixture();
    const wrongSession = await previewManagedWorkspaceSync({ ...roots, sessionId: "another-session" });
    expect(wrongSession.baseline).toEqual({ available: false, reason: "invalid" });
    expect(wrongSession.fingerprint).toBeNull();
  });

  it("uses a fixed sync exclusion policy for .git, .env, node_modules and service state", async () => {
    const roots = await fixture();
    await Promise.all([
      copyInitial(roots, "normal.txt", "base"),
      copyInitial(roots, ".env", "secret=base"),
      copyInitial(roots, ".git/config", "base git"),
      copyInitial(roots, "node_modules/pkg/index.js", "base module"),
    ]);
    await createManagedWorkspaceSyncBaseline(roots);
    await Promise.all([
      put(roots.mountPoint, "normal.txt", "managed"),
      put(roots.mountPoint, ".env", "secret=managed"),
      put(roots.mountPoint, ".git/config", "managed git"),
      put(roots.mountPoint, "node_modules/pkg/index.js", "managed module"),
    ]);
    const preview = await previewManagedWorkspaceSync(roots);
    expect(preview.changes.map((change) => change.path)).toEqual(["normal.txt"]);
  });

  it.skipIf(process.platform === "win32")("never follows a managed symlink when planning a sync", async () => {
    const roots = await baselineFixture();
    await rm(path.join(roots.mountPoint, "file.txt"));
    await symlink(path.join(roots.workspaceRoot, "outside"), path.join(roots.mountPoint, "file.txt"));
    const preview = await previewManagedWorkspaceSync(roots);
    expect(preview.changes.find((change) => change.path === "file.txt")).toMatchObject({ action: "unsupported", managed: { kind: "symlink" } });
  });

  it.runIf(process.platform === "win32")("treats a managed directory junction as a symlink instead of recursing into it", async () => {
    const roots = await fixture();
    await copyInitial(roots, "dir/file.txt", "base");
    await createManagedWorkspaceSyncBaseline(roots);
    const outside = path.join(roots.workspaceRoot, "outside-junction-target");
    await mkdir(outside);
    await rm(path.join(roots.mountPoint, "dir"), { recursive: true, force: true });
    await symlink(outside, path.join(roots.mountPoint, "dir"), "junction");
    const preview = await previewManagedWorkspaceSync(roots);
    expect(preview.changes.find((change) => change.path === "dir")).toMatchObject({ action: "unsupported", managed: { kind: "symlink" } });
    expect(preview.changes.find((change) => change.path === "dir/file.txt")).toMatchObject({ action: "unsupported", reason: "non_regular_entry" });
  });

  it("treats a traversal-bearing sidecar as invalid instead of using it", async () => {
    const roots = await baselineFixture();
    const baselinePath = managedWorkspaceSyncBaselinePath(roots.workspaceRoot);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as { entries: Record<string, unknown> };
    baseline.entries = { "../outside.txt": { kind: "file", sha256: "0".repeat(64), size: 0, mode: 0o644 } };
    await writeFile(baselinePath, JSON.stringify(baseline), "utf8");
    const preview = await previewManagedWorkspaceSync(roots);
    expect(preview.baseline).toEqual({ available: false, reason: "invalid" });
    expect(preview.fingerprint).toBeNull();
  });
});
