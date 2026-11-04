/**
 * 命令执行软超时的唯一来源：前台/后台 bash、持久 shell、诊断测试等
 * 所有“跑一条用户命令”的路径共用，避免各自维护一份默认值。
 * 0 表示不限时（由用户显式取消或会话结束收尾）。
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60_000;

/** core.exec.run 的 RPC 等待在命令软超时之外额外留的收尾余量。 */
export const EXEC_TIMEOUT_RPC_MARGIN_MS = 10_000;

/** 非命令类 core RPC（ping/fs/jobStatus 等）的默认请求超时。 */
export const DEFAULT_CORE_REQUEST_TIMEOUT_MS = 130_000;

/** core 协议 timeoutMs 是 int 毫秒；设置上限取 INT_MAX。 */
export const MAX_EXEC_TIMEOUT_MS = 2_147_483_647;

/** 命令软超时 → core RPC 等待；0（不限）时 RPC 也不设定时器。
 *  上限钳到 Node setTimeout 能接受的最大值（INT_MAX），避免最大设置值 + 余量溢出后
 *  被 Node 降成 1ms 立即失败。 */
export function execRpcTimeoutMs(commandTimeoutMs: number): number {
  return commandTimeoutMs > 0 ? Math.min(commandTimeoutMs + EXEC_TIMEOUT_RPC_MARGIN_MS, MAX_EXEC_TIMEOUT_MS) : 0;
}

/**
 * 命令输出保留上限：持久 shell 按解码字符计，一次性/jobControl 路径按
 * base64 字符计。两者描述同一个“约 1 MiB 解码输出”的预算，放在一起避免漂移。
 */
export const MAX_COMMAND_OUTPUT_CHARS = 1_000_000;
export const MAX_COMMAND_OUTPUT_B64_CHARS = 1_400_000;
