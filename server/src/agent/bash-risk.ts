import path from "node:path";
import type { SandboxMode, SandboxNetwork } from "../sessions/types.js";
import { isReadOnlyCommand, type ReadonlyShellFlavor } from "./readonly-command.js";
import { matchesBashCommandPrefix } from "./tool-policy.js";

/**
 * bash 风险分类：智能审核的机器/人工/模型三档输入。
 *
 * 判定始终保守：能证明低风险才返回 low；明确高危返回 high；其余 unknown。
 * 沙盒 enforced 时才允许路径/构建测试快道；partial/advisory/off 只允许
 * 能在静态上证明目标位于工作区内的只读命令。
 */

export interface BashSandboxContext {
  kind?: "local";
  mode?: SandboxMode;
  /** core 最近一次 configureSession 上报的执行级别。 */
  capability?: string;
  cwd: string;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  allowPaths?: readonly string[];
  denyPaths: readonly string[];
  network: SandboxNetwork;
}

export interface BashRiskResult {
  risk: "low" | "high" | "unknown";
  /** 是否允许机器直接放行（low 的子集；high/unknown 恒为 false）。 */
  machineAllow: boolean;
  reasons: string[];
}

/** 沙盒是否真正强制文件系统边界；WSB 由 VM 充当边界。 */
function isSandboxEnforced(sandbox: BashSandboxContext | undefined): boolean {
  if (!sandbox) return false;
  if (sandbox.mode === "wsb") return true;
  if (sandbox.mode === "off" || sandbox.mode === "jobobject") return false;
  return sandbox.capability === "enforced";
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.replace(/\\/g, "/").toLowerCase() : resolved;
}

function isWithin(child: string, root: string): boolean {
  const childNorm = normalizeForCompare(child);
  const rootNorm = normalizeForCompare(root);
  return childNorm === rootNorm || childNorm.startsWith(rootNorm.endsWith("/") ? rootNorm : `${rootNorm}/`);
}

/** 写根与额外可写目录都位于工作区内，才允许构建/测试走机器快道。 */
function writeRootsConfined(sandbox: BashSandboxContext | undefined): boolean {
  if (!sandbox) return false;
  if (sandbox.mode === "wsb") return true;
  const roots = sandbox.writeRoots.length > 0 ? sandbox.writeRoots : [sandbox.cwd];
  return [...roots, ...(sandbox.allowPaths ?? [])].every((root) => isWithin(root, sandbox.cwd));
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1);
  }
  return token;
}

function commandSegments(cmd: string): string[] {
  return cmd.split(/&&|\|\||[;&|\n\r]/).map((segment) => segment.trim()).filter(Boolean);
}

function segmentTokens(segment: string): string[] {
  return segment.split(/\s+/).map(stripQuotes).filter(Boolean);
}

/** 内置高危基线；返回命中的原因（未命中返回 undefined）。 */
function builtInHighRisk(cmd: string): string | undefined {
  for (const segment of commandSegments(cmd)) {
    const tokens = segmentTokens(segment);
    const first = tokens[0];
    if (!first) continue;
    const command = path.basename(first).toLowerCase();
    const args = tokens.slice(1);
    const has = (pattern: RegExp): boolean => args.some((arg) => pattern.test(arg));

    if (["sudo", "su", "doas", "pkexec", "runas"].includes(command)) return `privilege escalation: ${command}`;
    if (command === "rm" && (has(/^-[a-z]*[rf]/i) || has(/^--(recursive|force|no-preserve-root)$/i))) return "recursive/forced removal";
    if (["rmdir", "shred", "dd", "fdisk", "parted", "wipefs", "truncate"].includes(command) || command.startsWith("mkfs")) return `destructive disk/file command: ${command}`;
    if (["chmod", "chown", "chgrp"].includes(command)) return `permission/ownership change: ${command}`;
    if (["kill", "pkill", "killall", "systemctl", "service", "shutdown", "reboot", "crontab", "at"].includes(command)) return `process/system control: ${command}`;

    if (command === "git") {
      const sub = args[0]?.toLowerCase();
      if (sub === "push" || sub === "commit") return `git ${sub}`;
      if (sub === "reset" && args.includes("--hard")) return "git reset --hard";
      if (sub === "clean" && has(/^-[a-z]*[fdx]/i)) return "git clean with force/dirs";
    }

    if (command === "curl" || command === "wget") {
      if (has(/^(-d|--data|--data-raw|--data-binary|--post-data|--post-file|-F|--form|-T|--upload-file)(=|$)/i)) return `network upload: ${command}`;
    }
    if (["nc", "ncat", "socat", "ssh", "scp", "rsync"].includes(command)) return `remote/network command: ${command}`;
    if (["npm", "pnpm", "yarn"].includes(command) && args[0]?.toLowerCase() === "publish") return "package publish";
    if (command === "cargo" && args[0]?.toLowerCase() === "publish") return "package publish";
    if (command === "pip" && args[0]?.toLowerCase() === "upload") return "package upload";
    if (command === "twine" && args[0]?.toLowerCase() === "upload") return "package upload";
    if (command === "gh" && args[0]?.toLowerCase() === "release") return "release publish";

    if (["sh", "bash", "zsh", "dash", "ksh", "pwsh", "powershell", "cmd"].includes(command)) {
      // -c / -lc / -ec、/c、-Command、-EncodedCommand / -enc 都视为嵌套执行。
      if (args.some((arg) => /^-[a-z]*c[a-z]*$/i.test(arg) || /^\/c$/i.test(arg) || /^--?(command|encodedcommand|enc)$/i.test(arg))) return `nested shell: ${command}`;
    }
    if (command === "eval" || command === "source" || command === ".") return `dynamic evaluation: ${command}`;
    if (command === "find" && has(/^-(exec|execdir|ok|okdir)$/i)) return "find -exec";
    if (command === "xargs" && args.some((arg) => ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"].includes(arg.toLowerCase()))) return "xargs shell";
    if (command === "base64" && args.some((arg) => /^(-d|--decode)$/i.test(arg)) && cmd.includes("|")) return "base64 decode piped to shell";
  }
  return undefined;
}

function extraHighRisk(cmd: string, additions: readonly string[]): string | undefined {
  for (const pattern of additions) {
    if (pattern.trim() && matchesBashCommandPrefix(pattern.trim(), cmd)) return `configured high-risk command: ${pattern.trim()}`;
  }
  return undefined;
}

function hasShellExpansion(cmd: string): boolean {
  return /[`$]/.test(cmd);
}

function hasParentTraversal(cmd: string): boolean {
  return /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(cmd);
}

/** 非 enforced 沙盒下，只读命令的目标必须可静态证明位于工作区/读取根内。 */
function readOnlyTargetsConfined(cmd: string, sandbox: BashSandboxContext | undefined): boolean {
  if (!sandbox) return false;
  if (hasShellExpansion(cmd) || hasParentTraversal(cmd) || cmd.includes("~")) return false;
  const readRoots = sandbox.readRoots.length > 0 ? sandbox.readRoots : [sandbox.cwd];
  const tokens = cmd.split(/\s+/).map(stripQuotes).filter(Boolean);
  for (const raw of tokens) {
    // 支持 --flag=/path 与 -I/path 形态：只检查等号后的值与整 token 本身。
    const candidates = raw.includes("=") ? [raw, raw.slice(raw.indexOf("=") + 1)] : [raw];
    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith("-")) continue;
      const looksPathLike = candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.includes("/") || candidate.startsWith(".");
      if (!looksPathLike) continue;
      const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(sandbox.cwd, candidate);
      if (!readRoots.some((root) => isWithin(resolved, root))) return false;
      if (sandbox.denyPaths.some((deny) => isWithin(resolved, deny) || isWithin(deny, resolved))) return false;
    }
  }
  return true;
}

const BUILD_TEST_COMMANDS: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|lint|typecheck|check))\b/i,
  /^(?:pnpm|yarn)\s+(?:build|test|lint|typecheck)\b/i,
  /^(?:pytest|py\.test)\b/i,
  /^(?:npx\s+)?(?:vitest|jest)\b/i,
  /^(?:cargo\s+(?:test|check|build))\b/i,
  /^(?:go\s+(?:test|build|vet))\b/i,
  /^(?:make|gmake)\b/i,
  /^(?:dotnet\s+(?:test|build))\b/i,
  /^(?:mvn|mvnw)\s+(?:test|package|verify)\b/i,
  /^(?:gradle|gradlew)\s+(?:test|build|check)\b/i,
];

/** 构建/测试命令只接受单段、无 shell 控制字符/展开的形态。 */
function isBuildTestCommand(cmd: string): boolean {
  if (/[\n\r;&|<>`]/.test(cmd) || /\$[({]/.test(cmd)) return false;
  const trimmed = cmd.trim();
  return BUILD_TEST_COMMANDS.some((pattern) => pattern.test(trimmed));
}

export function classifyBash(
  cmd: string,
  shellFlavor: ReadonlyShellFlavor,
  sandbox: BashSandboxContext | undefined,
  highRiskCommands: readonly string[] = [],
): BashRiskResult {
  const high = builtInHighRisk(cmd) ?? extraHighRisk(cmd, highRiskCommands);
  if (high) return { risk: "high", machineAllow: false, reasons: [high] };

  const enforced = isSandboxEnforced(sandbox);
  if (isReadOnlyCommand(cmd, shellFlavor)) {
    if (enforced || readOnlyTargetsConfined(cmd, sandbox)) {
      return { risk: "low", machineAllow: true, reasons: [] };
    }
    return { risk: "unknown", machineAllow: false, reasons: ["read-only command targets paths outside the enforced sandbox"] };
  }

  if (isBuildTestCommand(cmd) && enforced && writeRootsConfined(sandbox)) {
    return { risk: "low", machineAllow: true, reasons: [] };
  }

  return { risk: "unknown", machineAllow: false, reasons: [] };
}

/** test_runner：自动探测命令视为构建/测试；自定义命令按 bash 分类。 */
export function classifyTestRunner(
  command: unknown,
  sandbox: BashSandboxContext | undefined,
  highRiskCommands: readonly string[] = [],
): BashRiskResult {
  if (typeof command === "string" && command.trim()) {
    return classifyBash(command, "sh", sandbox, highRiskCommands);
  }
  if (isSandboxEnforced(sandbox)) return { risk: "low", machineAllow: true, reasons: [] };
  return { risk: "unknown", machineAllow: false, reasons: [] };
}
