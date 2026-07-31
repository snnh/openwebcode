import type { CommandRunner } from "../../src/snapshots/probe.js";

/** 记录调用并按 handler 返回结果的 mock runner；lines() 返回完整命令行（cmd + args 拼接）。 */
export function recordingRunner(handler: (cmd: string, args: string[]) => { stdout?: string; code?: number }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = {
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      const result = handler(cmd, args);
      return { stdout: result.stdout ?? "", code: result.code ?? 0 };
    },
  };
  return { runner, calls, lines: () => calls.map(({ cmd, args }) => [cmd, ...args].join(" ")) };
}

/** 按完整命令行查表；未命中返回 code 1（模拟命令失败/不存在）。 */
export function tableRunner(responses: Record<string, { stdout?: string; code?: number }>) {
  return recordingRunner((cmd, args) => responses[[cmd, ...args].join(" ")] ?? { code: 1 });
}
