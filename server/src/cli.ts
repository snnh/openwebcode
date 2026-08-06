// C3 Headless CLI：`owc run "prompt" ...` 的入口。fetch 使用 Node 20 全局实现，WebSocket 使用 ws 兼容 Node 20。
// 流程：POST /api/sessions（或 --session 复用）→ WS 订阅 /api/events → POST messages → 按事件流输出。
// 退出码：agent.state=idle → 0；agent.error/连接失败 → 1；permission.request 且未带 --yolo → 2。

import WebSocket from "ws";
import { getServerVersion, readServerVersion } from "./version.js";
import { READ_ONLY_TOOL_NAMES } from "./agent/tool-schemas.js";

interface CliOptions {
  prompt: string;
  cwd: string;
  server: string;
  session?: string;
  provider?: string;
  model?: string;
  json: boolean;
  yolo: boolean;
  accessToken?: string | undefined;
  /** 会话级内置工具白名单（--tools；--read-only 时取 READ_ONLY_TOOL_NAMES）。 */
  tools?: string[];
  /** 会话级内置工具黑名单（--exclude-tools）。 */
  excludeTools?: string[];
  /** 便捷旗标：等价于 --tools <只读集>；与 --tools 互斥。 */
  readOnly: boolean;
  /** 会话级备选模型链（--fallback-models provider/model,...，最多 3 个）。 */
  fallbackModels?: Array<{ provider: string; model: string }>;
}

interface StreamEvent {
  type?: string;
  sessionId?: string;
  seq?: number;
  payload?: unknown;
}

function helpText(): string {
  return (
    `openwebcode ${getServerVersion()}\n` +
    "\n" +
    "用法: owc <命令> [选项]  Usage: owc <command> [options]\n" +
    "\n" +
    "命令 Commands:\n" +
    '  run "prompt"    非交互执行一次编码任务（面向 CI）  Run a coding task non-interactively (CI-friendly)\n' +
    "  --help, -h      显示本帮助  Show this help\n" +
    "  --version, -V   显示版本号  Show version\n" +
    "\n" +
    "owc run 选项 Options:\n" +
    "  --cwd DIR       工作目录（默认当前目录）  Working directory (default: current directory)\n" +
    "  --provider ID   服务商  Provider\n" +
    "  --model ID      模型  Model\n" +
    "  --server URL    服务地址（默认 http://127.0.0.1:3210）  Server URL (default http://127.0.0.1:3210)\n" +
    "  --session ID    复用已有会话（缺省新建）  Reuse an existing session (a new one is created otherwise)\n" +
    "  --json          以 NDJSON 输出事件流  Emit the event stream as NDJSON\n" +
    "  --yolo          自动批准权限请求  Auto-approve permission requests\n" +
    "  --tools LIST    仅暴露名单内内置工具（逗号分隔）  Only expose the listed built-in tools (comma-separated)\n" +
    "  --exclude-tools LIST  再剔除名单内内置工具  Additionally exclude the listed built-in tools\n" +
    "  --read-only     只读模式（等价于 --tools 只读集；与 --tools 互斥）  Read-only mode (equivalent to --tools with the read-only set; mutually exclusive with --tools)\n" +
    "  --fallback-models LIST  备选模型链（provider/model 逗号分隔，最多 3 个）  Fallback model chain (provider/model pairs, comma-separated, at most 3)\n" +
    "\n" +
    "退出码 Exit codes:\n" +
    "  0  任务完成  Completed\n" +
    "  1  agent 错误或连接失败  Agent error or connection failure\n" +
    "  2  遇到权限请求且未带 --yolo  Permission requested without --yolo\n" +
    "\n" +
    "环境变量 Environment variables:\n" +
    "  OWC_ACCESS_TOKEN  访问令牌（server 启用认证时必填）  Access token (required when server auth is enabled)\n"
  );
}

function printHelpAndExit(stream: "stdout" | "stderr", code: number): never {
  (stream === "stdout" ? process.stdout : process.stderr).write(helpText());
  process.exit(code);
}

function usage(): never {
  printHelpAndExit("stderr", 1);
}

function parseArgs(argv: string[]): CliOptions {
  if (argv[0] !== "run") usage();
  const options: CliOptions = { prompt: "", cwd: process.cwd(), server: "http://127.0.0.1:3210", json: false, yolo: false, readOnly: false, accessToken: process.env.OWC_ACCESS_TOKEN };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") printHelpAndExit("stdout", 0);
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--yolo") {
      options.yolo = true;
    } else if (arg === "--read-only") {
      options.readOnly = true;
    } else if (arg === "--cwd" || arg === "--provider" || arg === "--model" || arg === "--server" || arg === "--session" || arg === "--tools" || arg === "--exclude-tools" || arg === "--fallback-models") {
      const value = argv[++i];
      if (!value) usage();
      if (arg === "--cwd") options.cwd = value;
      else if (arg === "--provider") options.provider = value;
      else if (arg === "--model") options.model = value;
      else if (arg === "--server") options.server = value;
      else if (arg === "--session") options.session = value;
      else if (arg === "--fallback-models") {
        // provider/model 逗号分隔：按首个 "/" 切分（模型 id 自身可含 "/"）；逐项 trim，空项丢弃
        const entries: Array<{ provider: string; model: string }> = [];
        for (const item of value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
          const slash = item.indexOf("/");
          if (slash <= 0 || slash === item.length - 1) {
            process.stderr.write(`--fallback-models 格式错误："${item}"，应为 provider/model  --fallback-models format error: "${item}", expected provider/model\n`);
            process.exit(1);
          }
          entries.push({ provider: item.slice(0, slash), model: item.slice(slash + 1) });
        }
        if (entries.length > 3) {
          process.stderr.write("--fallback-models 最多 3 个备选模型  --fallback-models allows at most 3 entries\n");
          process.exit(1);
        }
        if (entries.length > 0) options.fallbackModels = entries;
      } else {
        // 逗号分隔工具名单：逐项 trim，空项丢弃
        const names = value.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
        if (arg === "--tools") options.tools = names;
        else options.excludeTools = names;
      }
    } else if (arg.startsWith("--")) {
      usage();
    } else if (!options.prompt) {
      options.prompt = arg;
    } else {
      usage();
    }
  }
  if (options.readOnly && options.tools) {
    process.stderr.write("--read-only 与 --tools 互斥，请只选一个  --read-only and --tools are mutually exclusive\n");
    process.exit(1);
  }
  if (!options.prompt) usage();
  return options;
}

async function postJson(url: string, body: unknown, accessToken?: string): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, text: () => response.text() };
}

async function main(): Promise<void> {
  // 解析并缓存版本号，使 --version/--help/usage 打印真实版本而非 0.0.0
  await readServerVersion();
  const argv = process.argv.slice(2);
  // --version / -V：打印版本后立即退出，不连接 server
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    process.stdout.write(`openwebcode ${getServerVersion()}\n`);
    return;
  }
  // --help / -h：打印双语帮助后退出 0，不连接 server
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) printHelpAndExit("stdout", 0);
  const options = parseArgs(argv);
  const server = options.server.replace(/\/+$/, "");

  // 1. 会话：--session 复用，否则新建
  let sessionId = options.session;
  if (!sessionId) {
    // --read-only 等价于 --tools <只读集>（解析期已保证与 --tools 互斥）
    const toolsAllow = options.readOnly ? [...READ_ONLY_TOOL_NAMES] : options.tools;
    const created = await postJson(`${server}/api/sessions`, {
      cwd: options.cwd,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(toolsAllow?.length ? { toolsAllow } : {}),
      ...(options.excludeTools?.length ? { toolsDeny: options.excludeTools } : {}),
      ...(options.fallbackModels?.length ? { fallbackModels: options.fallbackModels } : {}),
    }, options.accessToken);
    if (!created.ok) {
      process.stderr.write(`创建会话失败（HTTP ${created.status}）：${await created.text()}\n`);
      process.exit(1);
    }
    sessionId = (JSON.parse(await created.text()) as { id: string }).id;
  }

  // 2. WS 订阅事件流（先连再发消息，避免漏事件）；connected 事件的 latestSeq 作为基线，
  // seq <= 基线的是本次 run 之前的历史事件（--session 复用时尤其重要），一律忽略。
  const wsUrl = `${server.replace(/^http/i, "ws")}/api/events?sessionId=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(wsUrl, {
    headers: {
      "x-openwebcode-client": "cli",
      ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
    },
  });
  let baseline = -1;
  let finished = false;
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    try {
      ws.close();
    } catch {
      // 忽略关闭异常
    }
    // 给 stdout/stderr 一个 flush 窗口（Windows 管道下 process.exit 可能截断未写完的输出）
    setTimeout(() => process.exit(code), 50);
  };

  const onEvent = async (event: StreamEvent): Promise<void> => {
    if (typeof event.seq === "number" && event.seq <= baseline) return;
    if (event.sessionId && event.sessionId !== sessionId) return;
    if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "message.delta":
        if (!options.json && typeof payload.text === "string") process.stdout.write(payload.text);
        break;
      case "tool.start":
        if (!options.json) process.stdout.write(`\n[tool: ${String(payload.name ?? "?")}]\n`);
        break;
      case "agent.error":
        process.stderr.write(`agent 错误：${String(payload.message ?? "unknown")}\n`);
        finish(1);
        break;
      case "agent.state":
        if (payload.state === "idle") {
          if (!options.json) process.stdout.write("\n");
          finish(0);
        }
        break;
      case "permission.request":
        if (options.yolo) {
          const responded = await postJson(`${server}/api/sessions/${sessionId}/permissions/respond`, {
            requestId: payload.requestId,
            decision: "allow",
          }, options.accessToken);
          if (!responded.ok) {
            process.stderr.write(`权限自动批准失败（HTTP ${responded.status}）\n`);
            finish(1);
          }
        } else {
          process.stderr.write(`工具 ${String(payload.tool ?? "?")} 需要审批；非 --yolo 模式退出\n`);
          finish(2);
        }
        break;
      default:
        break;
    }
  };

  await new Promise<void>((resolve, reject) => {
    ws.onmessage = (message) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(String(message.data)) as StreamEvent;
      } catch {
        return;
      }
      if (event.type === "connected") {
        baseline = ((event.payload ?? {}) as { latestSeq?: number }).latestSeq ?? 0;
        ws.onmessage = (next) => {
          try {
            void onEvent(JSON.parse(String(next.data)) as StreamEvent);
          } catch {
            // 忽略无法解析的帧
          }
        };
        resolve();
      }
    };
    ws.onerror = () => reject(new Error(`WebSocket 连接失败：${wsUrl}`));
  });
  ws.onclose = () => {
    if (!finished) {
      process.stderr.write("事件流意外断开\n");
      finish(1);
    }
  };

  // 3. 发送消息，之后纯事件驱动
  const sent = await postJson(`${server}/api/sessions/${sessionId}/messages`, { content: options.prompt }, options.accessToken);
  if (!sent.ok) {
    process.stderr.write(`发送消息失败（HTTP ${sent.status}）：${await sent.text()}\n`);
    finish(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
