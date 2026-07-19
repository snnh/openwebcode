// C3 Headless CLI：`owc run "prompt" ...` 的入口。零新依赖（全局 fetch + WebSocket，Node 22+）。
// 流程：POST /api/sessions（或 --session 复用）→ WS 订阅 /api/events → POST messages → 按事件流输出。
// 退出码：agent.state=idle → 0；agent.error/连接失败 → 1；permission.request 且未带 --yolo → 2。
function usage() {
    process.stderr.write('用法: owc run "prompt" [--cwd .] [--provider X] [--model Y] [--json] [--yolo] [--server http://127.0.0.1:3000] [--session ID]\n');
    process.exit(2);
}
function parseArgs(argv) {
    if (argv[0] !== "run")
        usage();
    const options = { prompt: "", cwd: process.cwd(), server: "http://127.0.0.1:3000", json: false, yolo: false };
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") {
            options.json = true;
        }
        else if (arg === "--yolo") {
            options.yolo = true;
        }
        else if (arg === "--cwd" || arg === "--provider" || arg === "--model" || arg === "--server" || arg === "--session") {
            const value = argv[++i];
            if (!value)
                usage();
            if (arg === "--cwd")
                options.cwd = value;
            else if (arg === "--provider")
                options.provider = value;
            else if (arg === "--model")
                options.model = value;
            else if (arg === "--server")
                options.server = value;
            else
                options.session = value;
        }
        else if (arg.startsWith("--")) {
            usage();
        }
        else if (!options.prompt) {
            options.prompt = arg;
        }
        else {
            usage();
        }
    }
    if (!options.prompt)
        usage();
    return options;
}
async function postJson(url, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, text: () => response.text() };
}
async function main() {
    const options = parseArgs(process.argv.slice(2));
    const server = options.server.replace(/\/+$/, "");
    // 1. 会话：--session 复用，否则新建
    let sessionId = options.session;
    if (!sessionId) {
        const created = await postJson(`${server}/api/sessions`, {
            cwd: options.cwd,
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {}),
        });
        if (!created.ok) {
            process.stderr.write(`创建会话失败（HTTP ${created.status}）：${await created.text()}\n`);
            process.exit(1);
        }
        sessionId = JSON.parse(await created.text()).id;
    }
    // 2. WS 订阅事件流（先连再发消息，避免漏事件）；connected 事件的 latestSeq 作为基线，
    // seq <= 基线的是本次 run 之前的历史事件（--session 复用时尤其重要），一律忽略。
    const wsUrl = `${server.replace(/^http/i, "ws")}/api/events?sessionId=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
    let baseline = -1;
    let finished = false;
    const finish = (code) => {
        if (finished)
            return;
        finished = true;
        try {
            ws.close();
        }
        catch {
            // 忽略关闭异常
        }
        // 给 stdout/stderr 一个 flush 窗口（Windows 管道下 process.exit 可能截断未写完的输出）
        setTimeout(() => process.exit(code), 50);
    };
    const onEvent = async (event) => {
        if (typeof event.seq === "number" && event.seq <= baseline)
            return;
        if (event.sessionId && event.sessionId !== sessionId)
            return;
        if (options.json)
            process.stdout.write(`${JSON.stringify(event)}\n`);
        const payload = (event.payload ?? {});
        switch (event.type) {
            case "message.delta":
                if (!options.json && typeof payload.text === "string")
                    process.stdout.write(payload.text);
                break;
            case "tool.start":
                if (!options.json)
                    process.stdout.write(`\n[tool: ${String(payload.name ?? "?")}]\n`);
                break;
            case "agent.error":
                process.stderr.write(`agent 错误：${String(payload.message ?? "unknown")}\n`);
                finish(1);
                break;
            case "agent.state":
                if (payload.state === "idle") {
                    if (!options.json)
                        process.stdout.write("\n");
                    finish(0);
                }
                break;
            case "permission.request":
                if (options.yolo) {
                    const responded = await postJson(`${server}/api/sessions/${sessionId}/permissions/respond`, {
                        requestId: payload.requestId,
                        decision: "allow",
                    });
                    if (!responded.ok) {
                        process.stderr.write(`权限自动批准失败（HTTP ${responded.status}）\n`);
                        finish(1);
                    }
                }
                else {
                    process.stderr.write(`工具 ${String(payload.tool ?? "?")} 需要审批；非 --yolo 模式退出\n`);
                    finish(2);
                }
                break;
            default:
                break;
        }
    };
    await new Promise((resolve, reject) => {
        ws.onmessage = (message) => {
            let event;
            try {
                event = JSON.parse(String(message.data));
            }
            catch {
                return;
            }
            if (event.type === "connected") {
                baseline = (event.payload ?? {}).latestSeq ?? 0;
                ws.onmessage = (next) => {
                    try {
                        void onEvent(JSON.parse(String(next.data)));
                    }
                    catch {
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
    const sent = await postJson(`${server}/api/sessions/${sessionId}/messages`, { content: options.prompt });
    if (!sent.ok) {
        process.stderr.write(`发送消息失败（HTTP ${sent.status}）：${await sent.text()}\n`);
        finish(1);
    }
}
main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
export {};
