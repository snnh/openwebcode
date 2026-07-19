/**
 * 每个后台任务独占一个 core 进程。registry 通过 coreFactory 为该任务启动独立 CoreClient，
 * 走与主循环相同的 configureSession + sandbox 策略，然后发起 run 但不 await。
 * 主循环的 core 连接完全不受影响。
 *
 * 输出环形缓冲：每任务解码后文本总量上限 256KB，超限丢头部（记 truncated 标志）。
 * task_stop 即 kill 该任务专属 CoreClient 进程（Windows Job Object KILL_ON_JOB_CLOSE 保证
 *  kill core 进程即杀尽孙进程树）。posix 平台 kill 后孙进程可能孤儿化。
 */
export class BackgroundTaskRegistry {
    coreFactory;
    configureSession;
    onFinished;
    tasks = new Map();
    notices = new Map();
    constructor(coreFactory, configureSession, onFinished) {
        this.coreFactory = coreFactory;
        this.configureSession = configureSession;
        this.onFinished = onFinished;
    }
    async start(opts) {
        const { sessionId, taskId, cmd, cwd, timeoutMs } = opts;
        const client = this.coreFactory();
        const info = {
            taskId,
            sessionId,
            cmd,
            cwd,
            status: "running",
            startedAt: new Date().toISOString(),
        };
        const entry = {
            info,
            output: "",
            truncated: false,
            client,
            settled: false,
        };
        this.tasks.set(taskId, entry);
        // 收集输出
        client.on("event", (event) => {
            if (event.type === "exec.output" && event.payload?.data && typeof event.payload.data === "string") {
                const decoded = Buffer.from(event.payload.data, "base64").toString("utf8");
                this.appendOutput(entry, decoded);
            }
        });
        // 启动 core 连接
        await client.start();
        await this.configureSession(client, sessionId, cwd);
        // 发起 run（不 await），完成后处理终态
        void client.run({ sessionId, execId: taskId, cmd, cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
            .then((result) => this.finish(entry, "done", result.exitCode))
            .catch((error) => {
            if (entry.settled)
                return; // 已由 stop 标记为 stopped
            this.finish(entry, "failed", undefined, error.message);
        });
        return info;
    }
    get(taskId) {
        const entry = this.tasks.get(taskId);
        if (!entry)
            return undefined;
        return { ...entry.info, output: entry.output, ...(entry.truncated ? { truncated: true } : {}) };
    }
    listForSession(sessionId) {
        const result = [];
        for (const entry of this.tasks.values()) {
            if (entry.info.sessionId === sessionId) {
                result.push(entry.info);
            }
        }
        return result;
    }
    async stop(taskId) {
        const entry = this.tasks.get(taskId);
        if (!entry)
            return false;
        if (entry.settled)
            return true;
        entry.settled = true;
        entry.info.status = "stopped";
        entry.info.finishedAt = new Date().toISOString();
        try {
            await entry.client.stop();
        }
        catch {
            // 停止进程时的异常不影响状态标记
        }
        this.pushNotice(entry.info.sessionId, `后台任务 ${taskId} 已停止`);
        this.onFinished?.(entry.info);
        return true;
    }
    async stopForSession(sessionId) {
        const promises = [];
        for (const [taskId, entry] of this.tasks) {
            if (entry.info.sessionId === sessionId && !entry.settled) {
                promises.push(this.stop(taskId).then(() => undefined));
            }
        }
        await Promise.all(promises);
    }
    drainNotices(sessionId) {
        const notices = this.notices.get(sessionId);
        if (!notices)
            return [];
        this.notices.delete(sessionId);
        return notices;
    }
    async shutdown() {
        const promises = [];
        for (const [taskId, entry] of this.tasks) {
            if (!entry.settled) {
                entry.settled = true;
                promises.push((async () => {
                    try {
                        await entry.client.stop();
                    }
                    catch {
                        // 关停时忽略单个进程异常
                    }
                })());
            }
        }
        await Promise.all(promises);
        this.tasks.clear();
        this.notices.clear();
    }
    finish(entry, status, exitCode, errorMessage) {
        if (entry.settled)
            return;
        entry.settled = true;
        entry.info.status = status;
        if (exitCode !== undefined)
            entry.info.exitCode = exitCode;
        entry.info.finishedAt = new Date().toISOString();
        const cmdPreview = entry.info.cmd.length > 80 ? entry.info.cmd.slice(0, 80) + "..." : entry.info.cmd;
        const notice = status === "failed"
            ? `后台任务 ${entry.info.taskId} 失败：${errorMessage ?? "未知错误"}（${cmdPreview}）`
            : `后台任务 ${entry.info.taskId} 已结束（exit ${exitCode}）：${cmdPreview}`;
        this.pushNotice(entry.info.sessionId, notice);
        // 释放 core 进程
        void entry.client.stop().catch(() => undefined);
        this.onFinished?.(entry.info);
    }
    pushNotice(sessionId, notice) {
        const list = this.notices.get(sessionId) ?? [];
        list.push(notice);
        this.notices.set(sessionId, list);
    }
    appendOutput(entry, text) {
        const MAX_OUTPUT = 256 * 1024; // 256KB
        const newLength = entry.output.length + text.length;
        if (newLength > MAX_OUTPUT) {
            // 丢弃头部保留尾部；超限后持续滚动
            const excess = newLength - MAX_OUTPUT;
            if (excess >= entry.output.length) {
                // 旧输出全部丢弃，新文本从后截取
                entry.output = text.slice(excess - entry.output.length);
            }
            else {
                entry.output = entry.output.slice(excess) + text;
            }
            entry.truncated = true;
        }
        else {
            entry.output += text;
        }
    }
}
