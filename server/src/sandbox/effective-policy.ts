import type { JobObjectLimits, SandboxMode, SandboxPolicy } from "../sessions/types.js";

/**
 * 沙盒有效策略 builder：集中处理默认层、全局层、会话层、凭据/工具链自动挂载
 * 与 core 上限。输出最终策略 + 每项来源 + 被丢弃项，供 SandboxPanel 与排障使用。
 *
 * 调用方负责算好候选目录（凭据、node/python 工具链）；本模块只做合并、去重、
 * 上限与来源标注，避免与 core-router 形成循环依赖。
 */

const SANDBOX_LIMITS = {
  roots: 16,
  denyPaths: 16,
  allowPaths: 32,
  readOnlyPaths: 32,
  bindLinks: 16,
} as const;

type SandboxPolicySource =
  | "default"
  | "global"
  | "session"
  | "credential-git"
  | "credential-git-token"
  | "credential-ssh"
  | "toolchain-node"
  | "toolchain-python";

interface EffectivePolicyEntry {
  field: keyof SandboxPolicy;
  value: string;
  source: SandboxPolicySource;
}

interface DroppedPolicyEntry extends EffectivePolicyEntry {
  reason: string;
}

export interface EffectiveSandboxPolicy {
  policy: SandboxPolicy;
  entries: EffectivePolicyEntry[];
  dropped: DroppedPolicyEntry[];
}

export interface EffectiveSandboxPolicyInput {
  sandbox: SandboxPolicy;
  mode?: SandboxMode;
  platform: NodeJS.Platform;
  /** sandbox 本身来自内置默认还是会话/调用方显式值（只影响来源标注）。 */
  baseSource: "default" | "session";
  globalAllowPaths?: readonly string[];
  jobObject?: JobObjectLimits;
  credentials: { identity: readonly string[]; tokens: readonly string[]; ssh: readonly string[] };
  toolchainReadOnly: readonly string[];
  toolchainWrite: { node: readonly string[]; python: readonly string[] };
}

function assertExplicitCaps(sandbox: SandboxPolicy): void {
  const violations: string[] = [];
  if (sandbox.readRoots.length > SANDBOX_LIMITS.roots) violations.push(`readRoots ${sandbox.readRoots.length}>${SANDBOX_LIMITS.roots}`);
  if (sandbox.writeRoots.length > SANDBOX_LIMITS.roots) violations.push(`writeRoots ${sandbox.writeRoots.length}>${SANDBOX_LIMITS.roots}`);
  if (sandbox.denyPaths.length > SANDBOX_LIMITS.denyPaths) violations.push(`denyPaths ${sandbox.denyPaths.length}>${SANDBOX_LIMITS.denyPaths}`);
  if ((sandbox.allowPaths?.length ?? 0) > SANDBOX_LIMITS.allowPaths) violations.push(`allowPaths ${sandbox.allowPaths?.length}>${SANDBOX_LIMITS.allowPaths}`);
  if ((sandbox.readOnlyPaths?.length ?? 0) > SANDBOX_LIMITS.readOnlyPaths) violations.push(`readOnlyPaths ${sandbox.readOnlyPaths?.length}>${SANDBOX_LIMITS.readOnlyPaths}`);
  if ((sandbox.bindLinks?.length ?? 0) > SANDBOX_LIMITS.bindLinks) violations.push(`bindLinks ${sandbox.bindLinks?.length}>${SANDBOX_LIMITS.bindLinks}`);
  if (violations.length > 0) throw new Error(`sandbox policy exceeds core limits: ${violations.join(", ")}`);
}

function addEntry(entries: EffectivePolicyEntry[], field: keyof SandboxPolicy, value: string, source: SandboxPolicySource): void {
  entries.push({ field, value, source });
}

function capped(
  field: "readOnlyPaths" | "allowPaths",
  candidates: Array<{ value: string; source: SandboxPolicySource }>,
  cap: number,
  entries: EffectivePolicyEntry[],
  dropped: DroppedPolicyEntry[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.value || seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    if (result.length >= cap) {
      dropped.push({ field, value: candidate.value, source: candidate.source, reason: `core cap ${cap}` });
      continue;
    }
    result.push(candidate.value);
    addEntry(entries, field, candidate.value, candidate.source);
  }
  return result;
}

export function buildEffectiveSandboxPolicy(input: EffectiveSandboxPolicyInput): EffectiveSandboxPolicy {
  const { sandbox, mode } = input;
  assertExplicitCaps(sandbox);
  const entries: EffectivePolicyEntry[] = [];
  const dropped: DroppedPolicyEntry[] = [];

  for (const value of sandbox.readRoots) addEntry(entries, "readRoots", value, input.baseSource);
  for (const value of sandbox.writeRoots) addEntry(entries, "writeRoots", value, input.baseSource);
  for (const value of sandbox.denyPaths) addEntry(entries, "denyPaths", value, input.baseSource);
  for (const value of sandbox.bindLinks ?? []) addEntry(entries, "bindLinks", `${value.virtPath} <- ${value.backingPath}`, input.baseSource);
  addEntry(entries, "network", sandbox.network, input.baseSource);

  // WSB 由 VM 充当边界；off 显式关闭。与历史 policyFor 一致：二者都不再追加自动挂载。
  if (mode === "wsb") {
    const { bindLinks: _stripped, ...rest } = sandbox;
    addEntry(entries, "mode", "wsb", input.baseSource);
    return { policy: { ...rest, enabled: false }, entries, dropped };
  }
  if (mode === "off") {
    addEntry(entries, "mode", "off", input.baseSource);
    return { policy: { ...sandbox, enabled: false }, entries, dropped };
  }

  const baseAllowPaths = input.globalAllowPaths && input.globalAllowPaths.length > 0
    ? [...input.globalAllowPaths]
    : [...(sandbox.allowPaths ?? [])];

  const readOnlyCandidates: Array<{ value: string; source: SandboxPolicySource }> = [
    ...(sandbox.readOnlyPaths ?? []).map((value) => ({ value, source: input.baseSource })),
    ...input.credentials.identity.map((value) => ({ value, source: "credential-git" as const })),
    ...input.credentials.tokens.map((value) => ({ value, source: "credential-git-token" as const })),
    ...input.credentials.ssh.map((value) => ({ value, source: "credential-ssh" as const })),
    ...input.toolchainReadOnly.map((value) => ({ value, source: "toolchain-node" as const })),
  ];
  const writeCandidates: Array<{ value: string; source: SandboxPolicySource }> = [
    ...baseAllowPaths.map((value) => ({ value, source: input.globalAllowPaths && input.globalAllowPaths.length > 0 ? "global" as const : input.baseSource })),
    ...input.toolchainWrite.node.map((value) => ({ value, source: "toolchain-node" as const })),
    ...input.toolchainWrite.python.map((value) => ({ value, source: "toolchain-python" as const })),
  ];

  const readOnlyPaths = capped("readOnlyPaths", readOnlyCandidates, SANDBOX_LIMITS.readOnlyPaths, entries, dropped);
  const allowPaths = capped("allowPaths", writeCandidates, SANDBOX_LIMITS.allowPaths, entries, dropped);

  const policy: SandboxPolicy = {
    ...sandbox,
    ...(allowPaths.length > 0 ? { allowPaths } : {}),
    ...(readOnlyPaths.length > 0 ? { readOnlyPaths } : {}),
    ...(sandbox.jobMemoryMB === undefined && input.jobObject?.memoryMB !== undefined ? { jobMemoryMB: input.jobObject.memoryMB } : {}),
    ...(sandbox.jobMaxProcesses === undefined && input.jobObject?.maxProcesses !== undefined ? { jobMaxProcesses: input.jobObject.maxProcesses } : {}),
  };
  if (policy.jobMemoryMB !== undefined) addEntry(entries, "jobMemoryMB", String(policy.jobMemoryMB), sandbox.jobMemoryMB === undefined ? "global" : input.baseSource);
  if (policy.jobMaxProcesses !== undefined) addEntry(entries, "jobMaxProcesses", String(policy.jobMaxProcesses), sandbox.jobMaxProcesses === undefined ? "global" : input.baseSource);

  if (mode === "appcontainer") { policy.mode = "appcontainer"; addEntry(entries, "mode", "appcontainer", input.baseSource); }
  else if (mode === "bubblewrap") { policy.mode = "bubblewrap"; addEntry(entries, "mode", "bubblewrap", input.baseSource); }
  else if (mode === "jobobject") { policy.mode = "jobobject"; addEntry(entries, "mode", "jobobject", input.baseSource); }
  else if (mode === "landlock") addEntry(entries, "mode", "landlock", input.baseSource);

  return { policy, entries, dropped };
}
