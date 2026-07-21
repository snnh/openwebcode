import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/** 这些目录在创建托管工作区时不会复制，因此也绝不能在同步回源时带回。 */
export const MANAGED_WORKSPACE_COPY_EXCLUDES = new Set(["node_modules", ".owc", ".openwebcode"]);
/** 回写比初始复制更严格：绝不把 Git 元数据或 dotenv 密钥写回源目录。 */
export const MANAGED_WORKSPACE_SYNC_EXCLUDES = new Set([...MANAGED_WORKSPACE_COPY_EXCLUDES, ".git", ".env"]);
const BASELINE_FILE = "sync-baseline.json";
const MANIFEST_VERSION = 1;

export type ManagedWorkspaceSyncNode =
  | { kind: "file"; sha256: string; size: number; mode: number }
  | { kind: "directory" }
  | { kind: "symlink" }
  | { kind: "other" };

interface ManagedWorkspaceSyncTree {
  version: typeof MANIFEST_VERSION;
  createdAt: string;
  entries: Record<string, ManagedWorkspaceSyncNode>;
}

export interface ManagedWorkspaceSyncManifest extends ManagedWorkspaceSyncTree {
  /** Sidecar 与会话绑定，防止导入的 workspace meta 指向任意宿主目录。 */
  sessionId: string;
  origin: { path: string; dev: string; ino: string };
}

export interface ManagedWorkspaceSyncRoots {
  sessionId: string;
  /** 托管镜像与 manifest 所在的服务端目录，绝不位于挂载工作区内。 */
  workspaceRoot: string;
  /** 当前已挂载的托管工作区根目录。 */
  mountPoint: string;
  /** 用户创建会话时选择的源目录。 */
  originCwd: string;
}

export type ManagedWorkspaceSyncAction = "create" | "update" | "delete" | "none" | "conflict" | "unsupported";

/** 单一路径的三方比较：baseline=创建时（或上次已确认同步后）的共同版本。 */
export interface ManagedWorkspaceSyncChange {
  path: string;
  action: ManagedWorkspaceSyncAction;
  reason: "unchanged" | "origin_changed_only" | "managed_changed_only" | "already_in_sync" | "both_changed" | "legacy_no_baseline" | "non_regular_entry";
  baseline: ManagedWorkspaceSyncNode | null;
  origin: ManagedWorkspaceSyncNode | null;
  managed: ManagedWorkspaceSyncNode | null;
  originChanged: boolean;
  managedChanged: boolean;
}

export interface ManagedWorkspaceSyncSummary {
  create: number;
  update: number;
  delete: number;
  /** 两端都相对 baseline 改变且内容不同；默认绝不回写。 */
  conflicts: number;
  /** symlink、特殊文件、目录替换等非普通文件操作。 */
  unsupported: number;
  /** 没有需要回写的路径（含仅源目录改变）。 */
  unchanged: number;
}

export interface ManagedWorkspaceSyncBaselineStatus {
  available: boolean;
  reason?: "missing" | "invalid";
  createdAt?: string;
  version?: number;
}

/** 前端先取该对象展示三方差异，再把 fingerprint 原样回传给 apply。 */
export interface ManagedWorkspaceSyncPreview {
  baseline: ManagedWorkspaceSyncBaselineStatus;
  /** SHA-256；baseline 损坏时为 null。旧会话缺失 baseline 仍会给 legacy 预览指纹。 */
  fingerprint: string | null;
  changes: ManagedWorkspaceSyncChange[];
  summary: ManagedWorkspaceSyncSummary;
}

export interface ManagedWorkspaceSyncApplyInput {
  confirm: boolean;
  previewFingerprint: string;
  /** 显式选择时才会覆盖可安全写入的普通文件冲突；默认 false。 */
  overwriteConflicts?: boolean;
}

export interface ManagedWorkspaceSyncAppliedChange {
  path: string;
  action: "create" | "update" | "delete" | "overwrite";
}

export interface ManagedWorkspaceSyncApplyResult {
  applied: ManagedWorkspaceSyncAppliedChange[];
  /** 未覆盖或无法安全覆盖的冲突，仍保留给调用方展示。 */
  conflicts: ManagedWorkspaceSyncChange[];
  /** 不支持的 symlink/目录/特殊文件差异，始终不写入源目录。 */
  unsupported: ManagedWorkspaceSyncChange[];
  /** 已重新计算的结果；供前端直接刷新，不需要猜测基线是否更新。 */
  nextPreview: ManagedWorkspaceSyncPreview;
}

export type ManagedWorkspaceSyncErrorCode = "baseline_missing" | "baseline_invalid" | "confirmation_required" | "invalid_fingerprint" | "stale_preview" | "unsafe_path" | "scan_failed" | "apply_failed" | "sync_in_progress";

export class ManagedWorkspaceSyncError extends Error {
  constructor(readonly code: ManagedWorkspaceSyncErrorCode, message: string) {
    super(message);
    this.name = "ManagedWorkspaceSyncError";
  }
}

interface ComputedPreview {
  preview: ManagedWorkspaceSyncPreview;
  baseline?: ManagedWorkspaceSyncManifest;
  origin?: ManagedWorkspaceSyncTree;
  managed?: ManagedWorkspaceSyncTree;
}

interface PlannedOperation {
  change: ManagedWorkspaceSyncChange;
  action: "create" | "update" | "delete" | "overwrite";
}

export function managedWorkspaceSyncBaselinePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, BASELINE_FILE);
}

/** 初始复制结束后调用；manifest 在 workspaceRoot，永远不写进挂载 cwd。 */
export async function createManagedWorkspaceSyncBaseline(input: ManagedWorkspaceSyncRoots): Promise<ManagedWorkspaceSyncManifest> {
  const roots = normalizedRoots(input);
  const origin = await rootIdentity(roots.originCwd, false, "source directory");
  const scanned = await scanTree(roots.mountPoint, { allowRootReparse: true });
  const manifest: ManagedWorkspaceSyncManifest = { ...scanned, sessionId: roots.sessionId, origin };
  await writeBaseline(roots.workspaceRoot, manifest);
  return manifest;
}

export async function previewManagedWorkspaceSync(input: ManagedWorkspaceSyncRoots): Promise<ManagedWorkspaceSyncPreview> {
  return (await computePreview(input)).preview;
}

/**
 * 重新扫描三方状态并比对 preview fingerprint 后才落盘。没有隐式同步：
 * 调用者必须传 confirm=true；冲突默认只返回而不覆盖。
 */
export async function applyManagedWorkspaceSync(input: ManagedWorkspaceSyncRoots, request: ManagedWorkspaceSyncApplyInput): Promise<ManagedWorkspaceSyncApplyResult> {
  if (request.confirm !== true) throw new ManagedWorkspaceSyncError("confirmation_required", "confirm must be true before syncing a managed workspace");
  if (!/^[a-f0-9]{64}$/.test(request.previewFingerprint)) throw new ManagedWorkspaceSyncError("invalid_fingerprint", "previewFingerprint must be a SHA-256 hex string");

  const roots = normalizedRoots(input);
  const computed = await computePreview(roots);
  if (!computed.origin || !computed.managed || !computed.preview.fingerprint) {
    throw new ManagedWorkspaceSyncError("baseline_invalid", "This managed workspace has an invalid sync baseline; refusing to overwrite the source directory");
  }
  if (!computed.baseline && request.overwriteConflicts !== true) {
    throw new ManagedWorkspaceSyncError("baseline_missing", "This legacy managed workspace has no sync baseline; set overwriteConflicts to true only after reviewing every conflict");
  }
  if (computed.preview.fingerprint !== request.previewFingerprint) {
    throw new ManagedWorkspaceSyncError("stale_preview", "Workspace contents changed after preview; request a new sync preview before applying");
  }

  const operations = plannedOperations(computed.preview.changes, request.overwriteConflicts === true);
  const applied: ManagedWorkspaceSyncAppliedChange[] = [];
  try {
    for (const operation of operations) {
      await applyOperation(roots, operation);
      applied.push({ path: operation.change.path, action: operation.action });
    }
  } catch (error) {
    if (error instanceof ManagedWorkspaceSyncError) throw error;
    throw new ManagedWorkspaceSyncError("apply_failed", `Managed workspace sync stopped after ${applied.length} applied change(s); refresh the preview before retrying`);
  }

  // 只把已确认同步/两端已相同的路径推进 baseline；源目录独自修改和未解决冲突仍保留旧基线，
  // 这样后续 managed 改动不会悄悄覆盖用户在源目录里的外部修改。
  const refreshedOrigin = await scanTree(roots.originCwd, { allowRootReparse: false });
  const refreshedManaged = await scanTree(roots.mountPoint, { allowRootReparse: true });
  const updatedBaseline = computed.baseline
    ? advanceBaseline(computed.baseline, refreshedOrigin, refreshedManaged, computed.preview.changes, operations)
    : await legacyBaseline(roots, refreshedManaged);
  await writeBaseline(roots.workspaceRoot, updatedBaseline);
  const nextPreview = await previewManagedWorkspaceSync(roots);
  return {
    applied,
    conflicts: nextPreview.changes.filter((change) => change.action === "conflict"),
    unsupported: nextPreview.changes.filter((change) => change.action === "unsupported"),
    nextPreview,
  };
}

function normalizedRoots(input: ManagedWorkspaceSyncRoots): ManagedWorkspaceSyncRoots {
  if (!input.sessionId || /[\\/\u0000]/.test(input.sessionId)) throw new ManagedWorkspaceSyncError("unsafe_path", "Invalid managed workspace session id");
  const roots = {
    sessionId: input.sessionId,
    workspaceRoot: path.resolve(input.workspaceRoot),
    mountPoint: path.resolve(input.mountPoint),
    originCwd: path.resolve(input.originCwd),
  };
  // 让来源目录包含 VHD 挂载点或服务端工作区会造成自引用扫描/回写，保守拒绝。
  if (pathsOverlap(roots.originCwd, roots.mountPoint) || pathsOverlap(roots.originCwd, roots.workspaceRoot)) {
    throw new ManagedWorkspaceSyncError("unsafe_path", "Source directory must not overlap the managed workspace or its private metadata directory");
  }
  return roots;
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === "" || reverse === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) || (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse));
}

async function computePreview(input: ManagedWorkspaceSyncRoots): Promise<ComputedPreview> {
  const roots = normalizedRoots(input);
  const baselineState = await readBaseline(roots.workspaceRoot);
  if (baselineState.reason === "invalid") {
    return {
      preview: {
        baseline: { available: false, reason: "invalid" },
        fingerprint: null,
        changes: [],
        summary: emptySummary(),
      },
    };
  }
  let origin: ManagedWorkspaceSyncTree;
  let managed: ManagedWorkspaceSyncTree;
  try {
    const identity = await rootIdentity(roots.originCwd, false, "source directory");
    if (baselineState.manifest && !baselineMatchesRoots(baselineState.manifest, roots, identity)) {
      return {
        preview: {
          baseline: { available: false, reason: "invalid" },
          fingerprint: null,
          changes: [],
          summary: emptySummary(),
        },
      };
    }
    [origin, managed] = await Promise.all([
      scanTree(roots.originCwd, { allowRootReparse: false }),
      scanTree(roots.mountPoint, { allowRootReparse: true }),
    ]);
  } catch (error) {
    if (error instanceof ManagedWorkspaceSyncError) throw error;
    throw new ManagedWorkspaceSyncError("scan_failed", "Unable to scan managed workspace or source directory safely");
  }
  const changes = baselineState.manifest
    ? compareManifests(baselineState.manifest, origin, managed)
    : compareLegacyManifests(origin, managed);
  const fingerprint = previewFingerprint(baselineState.manifest, origin, managed);
  return {
    ...(baselineState.manifest ? { baseline: baselineState.manifest } : {}),
    origin,
    managed,
    preview: {
      baseline: baselineState.manifest
        ? { available: true, createdAt: baselineState.manifest.createdAt, version: baselineState.manifest.version }
        : { available: false, reason: "missing" },
      fingerprint,
      changes,
      summary: summarize(changes),
    },
  };
}

function baselineMatchesRoots(baseline: ManagedWorkspaceSyncManifest, roots: ManagedWorkspaceSyncRoots, origin: { path: string; dev: string; ino: string }): boolean {
  return baseline.sessionId === roots.sessionId
    && baseline.origin.path === origin.path
    && baseline.origin.dev === origin.dev
    && baseline.origin.ino === origin.ino;
}

function emptySummary(): ManagedWorkspaceSyncSummary {
  return { create: 0, update: 0, delete: 0, conflicts: 0, unsupported: 0, unchanged: 0 };
}

function summarize(changes: ManagedWorkspaceSyncChange[]): ManagedWorkspaceSyncSummary {
  const summary = emptySummary();
  for (const change of changes) {
    if (change.action === "create") summary.create += 1;
    else if (change.action === "update") summary.update += 1;
    else if (change.action === "delete") summary.delete += 1;
    else if (change.action === "conflict") summary.conflicts += 1;
    else if (change.action === "unsupported") summary.unsupported += 1;
    else summary.unchanged += 1;
  }
  return summary;
}

function compareManifests(baseline: ManagedWorkspaceSyncTree, origin: ManagedWorkspaceSyncTree, managed: ManagedWorkspaceSyncTree): ManagedWorkspaceSyncChange[] {
  const paths = new Set([...Object.keys(baseline.entries), ...Object.keys(origin.entries), ...Object.keys(managed.entries)]);
  const changes: ManagedWorkspaceSyncChange[] = [];
  for (const relativePath of [...paths].sort((left, right) => left.localeCompare(right))) {
    const base = baseline.entries[relativePath] ?? null;
    const source = origin.entries[relativePath] ?? null;
    const workspace = managed.entries[relativePath] ?? null;
    const originChanged = !nodesEqual(source, base);
    const managedChanged = !nodesEqual(workspace, base);
    if (!originChanged && !managedChanged) continue;

    let action: ManagedWorkspaceSyncAction;
    let reason: ManagedWorkspaceSyncChange["reason"];
    if (!managedChanged) {
      action = "none";
      reason = "origin_changed_only";
    } else if (nodesEqual(workspace, source)) {
      action = isRegularOrAbsent(workspace) ? "none" : "unsupported";
      reason = action === "none" ? "already_in_sync" : "non_regular_entry";
    } else if (!originChanged) {
      const safeAction = safeActionFor(workspace, base, source);
      action = safeAction ?? "unsupported";
      reason = action === "unsupported" ? "non_regular_entry" : "managed_changed_only";
    } else {
      action = "conflict";
      reason = "both_changed";
    }
    changes.push({
      path: relativePath,
      action,
      reason,
      baseline: cloneNode(base),
      origin: cloneNode(source),
      managed: cloneNode(workspace),
      originChanged,
      managedChanged,
    });
  }
  return suppressDescendantOperations(changes, baseline, origin, managed);
}

/** 旧会话没有可信共同版本：只展示两端差异，全部按 conflict 处理。 */
function compareLegacyManifests(origin: ManagedWorkspaceSyncTree, managed: ManagedWorkspaceSyncTree): ManagedWorkspaceSyncChange[] {
  const paths = new Set([...Object.keys(origin.entries), ...Object.keys(managed.entries)]);
  const changes: ManagedWorkspaceSyncChange[] = [];
  for (const relativePath of [...paths].sort((left, right) => left.localeCompare(right))) {
    const source = origin.entries[relativePath] ?? null;
    const workspace = managed.entries[relativePath] ?? null;
    if (nodesEqual(source, workspace)) continue;
    changes.push({
      path: relativePath,
      action: "conflict",
      reason: "legacy_no_baseline",
      baseline: null,
      origin: cloneNode(source),
      managed: cloneNode(workspace),
      originChanged: true,
      managedChanged: true,
    });
  }
  return suppressDescendantOperations(changes, undefined, origin, managed);
}

/**
 * 当任一树的祖先从目录变成普通文件、symlink 或特殊节点时，绝不继续处理其子路径。
 * 例如 managed 将 `dir` 换成 junction 时，旧 `dir/file` 不能被误判为安全删除。
 */
function suppressDescendantOperations(
  changes: ManagedWorkspaceSyncChange[],
  baseline: ManagedWorkspaceSyncTree | undefined,
  origin: ManagedWorkspaceSyncTree,
  managed: ManagedWorkspaceSyncTree,
): ManagedWorkspaceSyncChange[] {
  for (const change of changes) {
    if (!hasNonDirectoryAncestor(change.path, baseline, origin, managed)) continue;
    change.action = "unsupported";
    change.reason = "non_regular_entry";
  }
  return changes;
}

function hasNonDirectoryAncestor(relativePath: string, baseline: ManagedWorkspaceSyncTree | undefined, origin: ManagedWorkspaceSyncTree, managed: ManagedWorkspaceSyncTree): boolean {
  let slash = relativePath.lastIndexOf("/");
  while (slash !== -1) {
    const parent = relativePath.slice(0, slash);
    for (const node of [baseline?.entries[parent], origin.entries[parent], managed.entries[parent]]) {
      if (node && node.kind !== "directory") return true;
    }
    slash = parent.lastIndexOf("/");
  }
  return false;
}

function isRegularOrAbsent(node: ManagedWorkspaceSyncNode | null): boolean {
  return node === null || node.kind === "file";
}

/** 只有普通文件新增/更新，或未被来源改动过的普通文件删除，才可以默认写回。 */
function safeActionFor(managed: ManagedWorkspaceSyncNode | null, baseline: ManagedWorkspaceSyncNode | null, origin: ManagedWorkspaceSyncNode | null): "create" | "update" | "delete" | undefined {
  if (managed?.kind === "file") {
    if (baseline === null && origin === null) return "create";
    if (baseline?.kind === "file" && origin?.kind === "file") return "update";
    return undefined;
  }
  if (managed === null && baseline?.kind === "file" && origin?.kind === "file") return "delete";
  return undefined;
}

function overwriteActionFor(change: ManagedWorkspaceSyncChange): "create" | "update" | "delete" | undefined {
  if (change.managed?.kind === "file" && (change.origin === null || change.origin.kind === "file")) return change.origin === null ? "create" : "update";
  if (change.managed === null && change.origin?.kind === "file") return "delete";
  return undefined;
}

function plannedOperations(changes: ManagedWorkspaceSyncChange[], overwriteConflicts: boolean): PlannedOperation[] {
  const operations: PlannedOperation[] = [];
  for (const change of changes) {
    if (change.action === "create" || change.action === "update" || change.action === "delete") {
      operations.push({ change, action: change.action });
      continue;
    }
    if (overwriteConflicts && change.action === "conflict") {
      const action = overwriteActionFor(change);
      if (action) operations.push({ change, action: "overwrite" });
    }
  }
  // 新文件的父目录会在 copy 时按需创建；删除按更深路径优先，保持后续扩展为目录删除时安全。
  return operations.sort((left, right) => {
    if (left.action === "delete" && right.action !== "delete") return -1;
    if (right.action === "delete" && left.action !== "delete") return 1;
    if (left.action === "delete") return right.change.path.length - left.change.path.length || left.change.path.localeCompare(right.change.path);
    return left.change.path.localeCompare(right.change.path);
  });
}

async function applyOperation(roots: ManagedWorkspaceSyncRoots, operation: PlannedOperation): Promise<void> {
  const change = operation.change;
  const effectiveAction = operation.action === "overwrite" ? overwriteActionFor(change) : operation.action;
  if (!effectiveAction) throw new ManagedWorkspaceSyncError("apply_failed", `Cannot safely overwrite ${change.path}`);
  if (effectiveAction === "delete") {
    if (change.origin?.kind !== "file") throw new ManagedWorkspaceSyncError("apply_failed", `Cannot safely delete non-file ${change.path}`);
    await deleteVerifiedOriginFile(roots.originCwd, change.path, change.origin);
    return;
  }
  if (change.managed?.kind !== "file") throw new ManagedWorkspaceSyncError("apply_failed", `Cannot safely copy non-file ${change.path}`);
  await copyVerifiedManagedFile(roots, change.path, change.managed, change.origin);
}

async function copyVerifiedManagedFile(roots: ManagedWorkspaceSyncRoots, relativePath: string, expectedManaged: Extract<ManagedWorkspaceSyncNode, { kind: "file" }>, expectedOrigin: ManagedWorkspaceSyncNode | null): Promise<void> {
  const currentOrigin = await readNodeAt(roots.originCwd, relativePath, { allowRootReparse: false });
  if (!nodesEqual(currentOrigin, expectedOrigin)) throw new ManagedWorkspaceSyncError("stale_preview", `Source file changed before sync: ${relativePath}`);
  const parent = await ensureSafeParentDirectories(roots.originCwd, relativePath, { allowRootReparse: false, createMissing: true });
  if (!parent) throw new ManagedWorkspaceSyncError("unsafe_path", `Missing parent directory for ${relativePath}`);
  const target = safeJoin(roots.originCwd, relativePath);
  const temp = path.join(parent, `.${path.basename(target)}.owc-sync-${randomUUID()}.tmp`);
  try {
    await copyRegularFileVerified(roots.mountPoint, relativePath, temp, expectedManaged);
    const beforeRename = await readNodeAt(roots.originCwd, relativePath, { allowRootReparse: false });
    if (!nodesEqual(beforeRename, expectedOrigin)) throw new ManagedWorkspaceSyncError("stale_preview", `Source file changed while syncing: ${relativePath}`);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function deleteVerifiedOriginFile(root: string, relativePath: string, expected: Extract<ManagedWorkspaceSyncNode, { kind: "file" }>): Promise<void> {
  const current = await readNodeAt(root, relativePath, { allowRootReparse: false });
  if (!nodesEqual(current, expected)) throw new ManagedWorkspaceSyncError("stale_preview", `Source file changed before delete: ${relativePath}`);
  const target = safeJoin(root, relativePath);
  const afterCheck = await lstat(target);
  if (afterCheck.isSymbolicLink() || !afterCheck.isFile() || afterCheck.nlink > 1) throw new ManagedWorkspaceSyncError("unsafe_path", `Refusing to delete non-regular or hard-linked file: ${relativePath}`);
  await rm(target, { force: false });
}

async function copyRegularFileVerified(sourceRoot: string, relativePath: string, temporaryTarget: string, expected: Extract<ManagedWorkspaceSyncNode, { kind: "file" }>): Promise<void> {
  await ensureSafeParentDirectories(sourceRoot, relativePath, { allowRootReparse: true, createMissing: false });
  const source = safeJoin(sourceRoot, relativePath);
  const before = await lstat(source);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) throw new ManagedWorkspaceSyncError("unsafe_path", `Refusing to follow non-regular or hard-linked managed file: ${relativePath}`);
  const sourceHandle = await openNoFollow(source, constants.O_RDONLY);
  let targetHandle;
  try {
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.nlink > 1 || !sameFileIdentity(before, opened)) throw new ManagedWorkspaceSyncError("stale_preview", `Managed file changed before copy: ${relativePath}`);
    targetHandle = await open(temporaryTarget, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, expected.mode);
    const digest = createHash("sha256");
    const sourceStream = createReadStream(source, { fd: sourceHandle.fd, autoClose: false });
    sourceStream.on("data", (chunk: string | Buffer) => { digest.update(chunk); });
    const targetStream = createWriteStream(temporaryTarget, { fd: targetHandle.fd, autoClose: false });
    await pipeline(sourceStream, targetStream);
    const after = await sourceHandle.stat();
    if (!sameFileIdentity(opened, after) || digest.digest("hex") !== expected.sha256) throw new ManagedWorkspaceSyncError("stale_preview", `Managed file changed while copying: ${relativePath}`);
    await targetHandle.sync();
  } finally {
    if (targetHandle) await targetHandle.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
  await chmod(temporaryTarget, expected.mode).catch(() => undefined);
}

function advanceBaseline(
  baseline: ManagedWorkspaceSyncManifest,
  origin: ManagedWorkspaceSyncTree,
  managed: ManagedWorkspaceSyncTree,
  previousChanges: ManagedWorkspaceSyncChange[],
  operations: PlannedOperation[],
): ManagedWorkspaceSyncManifest {
  const entries: Record<string, ManagedWorkspaceSyncNode> = Object.fromEntries(Object.entries(baseline.entries).map(([key, value]) => [key, cloneNode(value)!]));
  const appliedPaths = new Set(operations.map((operation) => operation.change.path));
  const settledPaths = new Set<string>();
  for (const change of previousChanges) {
    const currentOrigin = origin.entries[change.path] ?? null;
    const currentManaged = managed.entries[change.path] ?? null;
    if (appliedPaths.has(change.path) || (change.managedChanged && nodesEqual(currentOrigin, currentManaged) && isBaselineSettleable(currentManaged))) settledPaths.add(change.path);
  }
  for (const relativePath of settledPaths) {
    const currentOrigin = origin.entries[relativePath] ?? null;
    const currentManaged = managed.entries[relativePath] ?? null;
    if (!nodesEqual(currentOrigin, currentManaged)) continue;
    if (currentManaged === null) delete entries[relativePath];
    else entries[relativePath] = cloneNode(currentManaged)!;
  }
  return { version: MANIFEST_VERSION, sessionId: baseline.sessionId, origin: baseline.origin, createdAt: new Date().toISOString(), entries };
}

function isBaselineSettleable(node: ManagedWorkspaceSyncNode | null): boolean {
  return node === null || node.kind === "file" || node.kind === "directory";
}

async function legacyBaseline(roots: ManagedWorkspaceSyncRoots, managed: ManagedWorkspaceSyncTree): Promise<ManagedWorkspaceSyncManifest> {
  const origin = await rootIdentity(roots.originCwd, false, "source directory");
  return {
    version: MANIFEST_VERSION,
    sessionId: roots.sessionId,
    origin,
    createdAt: new Date().toISOString(),
    entries: Object.fromEntries(Object.entries(managed.entries).map(([key, value]) => [key, cloneNode(value)!])),
  };
}

function previewFingerprint(baseline: ManagedWorkspaceSyncTree | undefined, origin: ManagedWorkspaceSyncTree, managed: ManagedWorkspaceSyncTree): string {
  const hash = createHash("sha256");
  hash.update("openwebcode-managed-workspace-sync-v1\n");
  for (const [label, manifest] of [["baseline", baseline], ["origin", origin], ["managed", managed]] as const) {
    hash.update(`${label}\n`);
    if (!manifest) continue;
    for (const key of Object.keys(manifest.entries).sort((left, right) => left.localeCompare(right))) {
      hash.update(key);
      hash.update("\u0000");
      hash.update(JSON.stringify(manifest.entries[key]));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

async function scanTree(root: string, options: { allowRootReparse: boolean }): Promise<ManagedWorkspaceSyncTree> {
  await assertDirectory(root, options.allowRootReparse, "workspace root");
  const entries: Record<string, ManagedWorkspaceSyncNode> = Object.create(null) as Record<string, ManagedWorkspaceSyncNode>;
  await scanDirectory(root, "", entries);
  return { version: MANIFEST_VERSION, createdAt: new Date().toISOString(), entries };
}

async function scanDirectory(root: string, relativeDirectory: string, output: Record<string, ManagedWorkspaceSyncNode>): Promise<void> {
  const directory = relativeDirectory ? safeJoin(root, relativeDirectory) : root;
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new ManagedWorkspaceSyncError("scan_failed", `Unable to read managed workspace directory${relativeDirectory ? `: ${relativeDirectory}` : ""}`);
  }
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    if (MANAGED_WORKSPACE_SYNC_EXCLUDES.has(child.name)) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
    if (!isSafeRelativePath(relativePath)) throw new ManagedWorkspaceSyncError("unsafe_path", "Unsafe relative path found while scanning managed workspace");
    const absolute = safeJoin(root, relativePath);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      throw new ManagedWorkspaceSyncError("scan_failed", `Unable to inspect managed workspace path: ${relativePath}`);
    }
    if (info.isSymbolicLink()) {
      output[relativePath] = { kind: "symlink" };
      continue;
    }
    if (info.isDirectory()) {
      output[relativePath] = { kind: "directory" };
      await scanDirectory(root, relativePath, output);
      continue;
    }
    if (info.isFile()) {
      if (info.nlink > 1) {
        output[relativePath] = { kind: "other" };
        continue;
      }
      output[relativePath] = await hashRegularFile(absolute, info, relativePath);
      continue;
    }
    output[relativePath] = { kind: "other" };
  }
}

async function readNodeAt(root: string, relativePath: string, options: { allowRootReparse: boolean }): Promise<ManagedWorkspaceSyncNode | null> {
  const parent = await ensureSafeParentDirectories(root, relativePath, { allowRootReparse: options.allowRootReparse, createMissing: false, missingAsAbsent: true });
  if (!parent) return null;
  const target = safeJoin(root, relativePath);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new ManagedWorkspaceSyncError("scan_failed", `Unable to inspect source path: ${relativePath}`);
  }
  if (info.isSymbolicLink()) return { kind: "symlink" };
  if (info.isDirectory()) return { kind: "directory" };
  if (info.isFile()) return info.nlink > 1 ? { kind: "other" } : hashRegularFile(target, info, relativePath);
  return { kind: "other" };
}

async function hashRegularFile(filePath: string, before: Awaited<ReturnType<typeof lstat>>, relativePath: string): Promise<Extract<ManagedWorkspaceSyncNode, { kind: "file" }>> {
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) throw new ManagedWorkspaceSyncError("unsafe_path", `Refusing to hash non-regular or hard-linked file: ${relativePath}`);
  const handle = await openNoFollow(filePath, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) throw new ManagedWorkspaceSyncError("stale_preview", `File changed before hashing: ${relativePath}`);
    const digest = createHash("sha256");
    const stream = createReadStream(filePath, { fd: handle.fd, autoClose: false });
    for await (const chunk of stream) digest.update(chunk as Buffer);
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after)) throw new ManagedWorkspaceSyncError("stale_preview", `File changed while hashing: ${relativePath}`);
    return { kind: "file", sha256: digest.digest("hex"), size: opened.size, mode: opened.mode & 0o777 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function openNoFollow(filePath: string, flags: number) {
  // O_NOFOLLOW is enforced on POSIX. Windows lacks an equivalent flag, so lstat + fstat
  // identity checks above still reject a reparse/symlink swap before data is accepted.
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  return open(filePath, flags | noFollow);
}

async function ensureSafeParentDirectories(root: string, relativePath: string, options: { allowRootReparse: boolean; createMissing: boolean; missingAsAbsent?: boolean }): Promise<string | undefined> {
  if (!isSafeRelativePath(relativePath)) throw new ManagedWorkspaceSyncError("unsafe_path", "Unsafe relative path");
  await assertDirectory(root, options.allowRootReparse, "workspace root");
  const parts = relativePath.split("/");
  const directories = parts.slice(0, -1);
  let current = root;
  for (const part of directories) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isMissing(error) || !options.createMissing) {
        if (isMissing(error) && options.missingAsAbsent) return undefined;
        throw new ManagedWorkspaceSyncError("unsafe_path", `Missing or unsafe parent directory for ${relativePath}`);
      }
      await mkdir(current, { recursive: false });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ManagedWorkspaceSyncError("unsafe_path", `Refusing to traverse non-directory parent for ${relativePath}`);
  }
  return current;
}

async function assertDirectory(directory: string, allowReparse: boolean, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    throw new ManagedWorkspaceSyncError("unsafe_path", `Missing ${label}`);
  }
  if (!info.isDirectory() || (!allowReparse && info.isSymbolicLink())) throw new ManagedWorkspaceSyncError("unsafe_path", `Unsafe ${label}`);
}

async function rootIdentity(directory: string, allowReparse: boolean, label: string): Promise<{ path: string; dev: string; ino: string }> {
  const resolved = path.resolve(directory);
  let info;
  try {
    info = await lstat(resolved);
  } catch {
    throw new ManagedWorkspaceSyncError("unsafe_path", `Missing ${label}`);
  }
  if (!info.isDirectory() || (!allowReparse && info.isSymbolicLink())) throw new ManagedWorkspaceSyncError("unsafe_path", `Unsafe ${label}`);
  return { path: resolved, dev: String(info.dev), ino: String(info.ino) };
}

function safeJoin(root: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) throw new ManagedWorkspaceSyncError("unsafe_path", "Unsafe relative path");
  const target = path.resolve(root, ...relativePath.split("/"));
  const relation = path.relative(root, target);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw new ManagedWorkspaceSyncError("unsafe_path", "Path escapes workspace root");
  return target;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\u0000") || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function nodesEqual(left: ManagedWorkspaceSyncNode | null, right: ManagedWorkspaceSyncNode | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind !== "file" || right.kind !== "file") return true;
  return left.sha256 === right.sha256 && left.size === right.size && left.mode === right.mode;
}

function cloneNode(node: ManagedWorkspaceSyncNode | null): ManagedWorkspaceSyncNode | null {
  if (node === null) return null;
  return node.kind === "file" ? { ...node } : { ...node };
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs;
}

async function readBaseline(workspaceRoot: string): Promise<{ manifest?: ManagedWorkspaceSyncManifest; reason?: "missing" | "invalid" }> {
  const baselinePath = managedWorkspaceSyncBaselinePath(workspaceRoot);
  let raw: string;
  try {
    const info = await lstat(baselinePath);
    if (info.isSymbolicLink() || !info.isFile()) return { reason: "invalid" };
    raw = await readFile(baselinePath, "utf8");
  } catch (error) {
    if (isMissing(error)) return { reason: "missing" };
    return { reason: "invalid" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const manifest = validateManifest(parsed);
    return { manifest };
  } catch {
    return { reason: "invalid" };
  }
}

async function writeBaseline(workspaceRoot: string, manifest: ManagedWorkspaceSyncManifest): Promise<void> {
  await assertDirectory(workspaceRoot, false, "managed workspace metadata directory");
  const target = managedWorkspaceSyncBaselinePath(workspaceRoot);
  const temporary = path.join(workspaceRoot, `.${BASELINE_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function validateManifest(value: unknown): ManagedWorkspaceSyncManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid manifest");
  const candidate = value as { version?: unknown; sessionId?: unknown; origin?: unknown; createdAt?: unknown; entries?: unknown };
  if (candidate.version !== MANIFEST_VERSION || typeof candidate.sessionId !== "string" || !candidate.sessionId || /[\\/\u0000]/.test(candidate.sessionId) || typeof candidate.createdAt !== "string" || !candidate.createdAt || !candidate.entries || typeof candidate.entries !== "object" || Array.isArray(candidate.entries)) throw new Error("invalid manifest");
  if (!candidate.origin || typeof candidate.origin !== "object" || Array.isArray(candidate.origin)) throw new Error("invalid origin identity");
  const origin = candidate.origin as { path?: unknown; dev?: unknown; ino?: unknown };
  if (typeof origin.path !== "string" || path.resolve(origin.path) !== origin.path || typeof origin.dev !== "string" || !origin.dev || typeof origin.ino !== "string" || !origin.ino) throw new Error("invalid origin identity");
  const entries: Record<string, ManagedWorkspaceSyncNode> = Object.create(null) as Record<string, ManagedWorkspaceSyncNode>;
  for (const [relativePath, node] of Object.entries(candidate.entries as Record<string, unknown>)) {
    if (!isSafeRelativePath(relativePath)) throw new Error("unsafe manifest path");
    entries[relativePath] = validateNode(node);
  }
  return { version: MANIFEST_VERSION, sessionId: candidate.sessionId, origin: { path: origin.path, dev: origin.dev, ino: origin.ino }, createdAt: candidate.createdAt, entries };
}

function validateNode(value: unknown): ManagedWorkspaceSyncNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid node");
  const node = value as { kind?: unknown; sha256?: unknown; size?: unknown; mode?: unknown };
  if (node.kind === "file") {
    const { sha256, size, mode } = node;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || typeof mode !== "number" || !Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) throw new Error("invalid file node");
    return { kind: "file", sha256, size, mode };
  }
  if (node.kind === "directory" || node.kind === "symlink" || node.kind === "other") return { kind: node.kind };
  throw new Error("invalid node kind");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
