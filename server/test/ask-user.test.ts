import { describe, expect, it, vi } from "vitest";
import { InteractionCoordinator } from "../src/agent/interaction-coordinator.js";
import { PermissionCoordinator, permissionRule } from "../src/agent/permission-coordinator.js";
import { buildReviewMessages, parseVerdict } from "../src/agent/permission-review.js";
import type { CoreClientLike } from "../src/core-client.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import type { FastModelClient } from "../src/fast-model.js";
import type { Provider, StreamChatRequest } from "../src/providers/provider.js";
import { makeAgentHarness, toolResultOf, waitForPendingInteraction, waitForToolMessage } from "./helpers/agent-harness.js";
import { makeControllableCore, makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

function createFakeCore(): CoreClientLike {
  return makeFakeCore({
    async readFile() { return { content: "file content" }; },
    async globFiles() { return { matches: [] }; },
    async grepFiles() { return { matches: [] }; },
    async editFile() { return { matches: 1 }; },
    async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as Partial<CoreClientLike>);
}

interface AskSetup {
  agentMode?: "plan" | "code";
  toolCallId?: string;
  input: Record<string, unknown>;
}

async function setup(options: AskSetup) {
  const toolCallId = options.toolCallId ?? "ask-1";
  // 首轮固定调用 ask_user；看到 tool_result 后输出文本收尾
  const provider: Provider = {
    name: "fake",
    async *streamChat(request: StreamChatRequest) {
      const answered = request.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.toolCallId === toolCallId));
      if (!answered) {
        yield { type: "tool_call", id: toolCallId, name: "ask_user", input: options.input };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "已收到回答" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
  return makeAgentHarness({
    provider,
    core: createFakeCore(),
    model: "model",
    tempPrefix: "owc-ask-user-",
    ...(options.agentMode ? { agentMode: options.agentMode } : {}),
  });
}

describe("ask_user 工具", () => {
  it("confirm：发布 interaction.requested，REST respond 后工具结果含布尔答案，agent 继续", async () => {
    const harness = await setup({ input: { questions: [{ question: "继续执行吗？", type: "confirm" }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      expect(pending.kind).toBe("confirm");
      expect(pending.prompt).toBe("继续执行吗？");
      // interaction.requested 已发布到事件流
      expect(harness.events.replay(0, harness.session.id).events.some((event) => event.type === "interaction.requested")).toBe(true);
      // ask_user 是用户交互工具：不得产生 permission.request
      expect(harness.events.replay(0, harness.session.id).events.some((event) => event.type === "permission.request")).toBe(false);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: true } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const detail = await harness.sessions.get(harness.session.id);
      const result = toolResultOf(detail, "ask-1");
      expect(result).toBeDefined();
      expect(result!.isError).toBe(false);
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ question: string; type: string; answer: unknown }>;
      expect(parsed).toEqual([{ question: "继续执行吗？", type: "confirm", answer: true }]);
      // agent 继续并输出最终文本
      const finalText = detail?.messages.filter((message) => message.role === "assistant").flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
      expect(finalText).toContain("已收到回答");
      // 交互状态已落盘为 answered
      const interactions = await harness.agent.listInteractions(harness.session.id);
      expect(interactions[0]?.status).toBe("answered");
    } finally {
      await harness.app.close();
    }
  });

  it.each([
    {
      name: "multi_select：工具结果返回选中项 label 数组，交互附 allowOther",
      input: {
        questions: [{
          question: "选择要迁移的模块",
          header: "模块选择",
          type: "multi_select",
          options: [{ label: "core" }, { label: "server", description: "Node 服务层" }, { label: "web" }],
        }],
      },
      answer: ["opt-0", "opt-2"] as unknown,
      expectedAnswer: ["core", "web"] as unknown,
      expectedTitle: "模块选择",
      expectedLabels: ["core", "server", "web"] as string[] | undefined,
      expectedAllowOther: true as boolean | undefined,
    },
    {
      name: "text：工具结果返回字符串答案，无 allowOther",
      input: { questions: [{ question: "目标分支名？", type: "text" }] },
      answer: "feature/export" as unknown,
      expectedAnswer: "feature/export" as unknown,
      expectedTitle: undefined as string | undefined,
      expectedLabels: undefined as string[] | undefined,
      expectedAllowOther: undefined as boolean | undefined,
    },
  ])("$name", async ({ input, answer, expectedAnswer, expectedTitle, expectedLabels, expectedAllowOther }) => {
    const harness = await setup({ input });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      if (expectedTitle !== undefined) expect(pending.title).toBe(expectedTitle);
      if (expectedLabels !== undefined) expect(pending.options?.map((option) => option.label)).toEqual(expectedLabels);
      expect(pending.allowOther).toBe(expectedAllowOther);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ answer: unknown }>;
      expect(parsed[0]?.answer).toEqual(expectedAnswer);
    } finally {
      await harness.app.close();
    }
  });

  it("「其他」选项：single_select 回答 other:<文本> 返回自定义文本；空文本被忽略", async () => {
    const harness = await setup({ input: { questions: [{ question: "选择目标环境", type: "single_select", options: [{ label: "staging" }, { label: "production" }] }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      expect(pending.allowOther).toBe(true);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: "other:自定义环境" } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ answer: unknown }>;
      expect(parsed[0]?.answer).toEqual(["自定义环境"]);
    } finally {
      await harness.app.close();
    }
  });

  it("「其他」选项：multi_select 混合常规选项与 other:<文本>，空 other 项被忽略", async () => {
    const harness = await setup({
      toolCallId: "ask-mixed",
      input: { questions: [{ question: "选择要迁移的模块", type: "multi_select", options: [{ label: "core" }, { label: "web" }] }] },
    });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: ["opt-0", "other:自定义模块", "other:"] } });
      expect(res.statusCode, res.body).toBe(200);
      await run;
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-mixed");
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ answer: unknown }>;
      expect(parsed[0]?.answer).toEqual(["core", "自定义模块"]);
    } finally {
      await harness.app.close();
    }
  });

  it("plan 模式不拦截 ask_user", async () => {
    const harness = await setup({ agentMode: "plan", input: { questions: [{ question: "计划是否可行？", type: "confirm" }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      const pending = await waitForPendingInteraction(harness.agent, harness.session.id);
      await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/interactions/${pending.id}/respond`, payload: { answer: false } });
      await run;
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      expect(result!.isError).toBe(false);
      expect((result as { content: string }).content).not.toContain("Plan 模式为只读");
      const parsed = JSON.parse((result as { content: string }).content) as Array<{ answer: unknown }>;
      expect(parsed[0]?.answer).toBe(false);
    } finally {
      await harness.app.close();
    }
  });

  it("run abort：挂起的交互解析为 { cancelled: true }（非错误结果）", async () => {
    const harness = await setup({ input: { questions: [{ question: "继续？", type: "confirm" }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      await waitForPendingInteraction(harness.agent, harness.session.id);
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/abort` });
      expect(res.statusCode).toBe(202);
      // abort 路径 run() 会 rethrow（agent.aborted 语义），工具结果仍已落盘
      await run.then(() => undefined, () => undefined);
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      expect(result).toBeDefined();
      expect(result!.isError).toBe(false);
      expect(JSON.parse((result as { content: string }).content)).toEqual({ cancelled: true });
    } finally {
      await harness.app.close();
    }
  });

  it("run abort 竞态：abort 先于 waiter 注册也能解析为 { cancelled: true }（不挂起）", async () => {
    // 模拟 CI 并发竞态：ask_user 交互创建后立即 abort，不等 waitForPendingInteraction
    // 轮询。此时 waitForInteractionAnswer 的 signal.aborted 检查与 addEventListener 之间
    // 存在让出窗口，abort 若落入该窗口会被 signal 事件漏掉（旧实现永久挂起直到 30s 超时）。
    // cancelInteractionWaiters + 注册后复检双重兜底确保不挂起。
    const harness = await setup({ input: { questions: [{ question: "继续？", type: "confirm" }] } });
    try {
      const run = harness.agent.run(harness.session.id, "先问我");
      // 立即 abort：不等待 pending 交互出现，制造 abort 与 waiter 注册的竞态。
      // 若 abort 早于 provider 流式 tool_call 落盘，tool_call 可能未持久化，
      // 此时 toolResultOf 找不到结果属正常；核心断言是 run 在合理时间内结束（不挂起）。
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/abort` });
      expect(res.statusCode).toBe(202);
      await run.then(() => undefined, () => undefined);
      // 若 tool_call 已落盘，结果必为 { cancelled: true }（非错误）；未落盘则跳过
      const result = toolResultOf(await harness.sessions.get(harness.session.id), "ask-1");
      if (result) {
        expect(result.isError).toBe(false);
        expect(JSON.parse((result as { content: string }).content)).toEqual({ cancelled: true });
      }
    } finally {
      await harness.app.close();
    }
  });

  it("输入校验：0 题 / 选项不足 / 超过 4 题 / confirm 携带 options 均被拒绝", async () => {
    const cases: Array<{ id: string; input: Record<string, unknown>; message: string }> = [
      { id: "v-empty", input: { questions: [] }, message: "1-4 questions" },
      { id: "v-one-option", input: { questions: [{ question: "选一个", type: "single_select", options: [{ label: "仅一项" }] }] }, message: "2-4 options" },
      { id: "v-five", input: { questions: [1, 2, 3, 4, 5].map((index) => ({ question: `q${index}`, type: "confirm" })) }, message: "1-4 questions" },
      { id: "v-confirm-options", input: { questions: [{ question: "确认？", type: "confirm", options: [{ label: "a" }, { label: "b" }] }] }, message: "must not carry options" },
      { id: "v-empty-label", input: { questions: [{ question: "选一个", type: "multi_select", options: [{ label: "" }, { label: "b" }] }] }, message: "non-empty label" },
    ];
    for (const testCase of cases) {
      const harness = await setup({ toolCallId: testCase.id, input: testCase.input });
      try {
        await harness.agent.run(harness.session.id, "先问我");
        const result = toolResultOf(await harness.sessions.get(harness.session.id), testCase.id);
        expect(result, testCase.id).toBeDefined();
        expect(result!.isError, testCase.id).toBe(true);
        expect((result as { content: string }).content, testCase.id).toContain(testCase.message);
        // 校验失败不得产生任何交互
        expect(await harness.agent.listInteractions(harness.session.id), testCase.id).toEqual([]);
      } finally {
        await harness.app.close();
      }
    }
  });
});

// ---- interaction-coordinator 组（合并） ----
describe("InteractionCoordinator", () => {
  it("creates, answers and lists interactions", async () => {
    const root = await tempRoot("owc-interactions-");
    const coordinator = new InteractionCoordinator(() => root);
    const created = await coordinator.create("s1", { runId: "r1", kind: "confirm", title: "t", prompt: "p" });
    expect(created.status).toBe("pending");
    const answered = await coordinator.answer("s1", created.id, { ok: true });
    expect(answered?.status).toBe("answered");
    expect((await coordinator.list("s1"))[0]).toMatchObject({ id: created.id, status: "answered" });
  });

  it("prunes the oldest resolved interactions beyond the retention cap, keeping pending", async () => {
    const root = await tempRoot("owc-interactions-cap-");
    const coordinator = new InteractionCoordinator(() => root);
    for (let index = 0; index < 505; index += 1) {
      const item = await coordinator.create("s1", { runId: "r1", kind: "confirm", title: `t${index}`, prompt: "p" });
      await coordinator.answer("s1", item.id, index);
    }
    const pending = await coordinator.create("s1", { runId: "r1", kind: "confirm", title: "pending", prompt: "p" });
    const items = await coordinator.list("s1");
    // 500 条已完结保留上限 + 1 条 pending（永不裁剪）
    expect(items).toHaveLength(501);
    expect(items.filter((item) => item.status === "pending").map((item) => item.id)).toEqual([pending.id]);
    // 最旧的 5 条 answered 被裁掉，剩余按原顺序从 t5 开始
    expect(items[0]).toMatchObject({ title: "t5" });
  });
});

// ---- permission-coordinator 组（合并） ----
describe("PermissionCoordinator", () => {
  it("bypasses only allowed read, edit, yolo, and persisted rules", () => {
    const coordinator = new PermissionCoordinator(new EventBus());
    expect(coordinator.needsApproval("ask", [], "read_file", { path: "a" })).toBe(false);
    expect(coordinator.needsApproval("ask", [], "todo_write", { items: [] })).toBe(false);
    expect(coordinator.needsApproval("ask", [], "bash", { cmd: "npm test" })).toBe(true);
    expect(coordinator.needsApproval("ask", [], "bash", { cmd: "cd x && echo hi && ls" })).toBe(false);
    expect(coordinator.needsApproval("ask", [], "bash", { cmd: "ls 2>/dev/null | head; find . -name '*.ts' | head" })).toBe(false);
    expect(coordinator.needsApproval("acceptEdits", [], "bash", { cmd: "head x && rm -rf /" })).toBe(true);
    expect(coordinator.needsApproval("review", [], "bash", { cmd: "git status" })).toBe(false);
    expect(coordinator.needsApproval("acceptEdits", [], "edit_file", { path: "a" })).toBe(false);
    expect(coordinator.needsApproval("yolo", [], "bash", { cmd: "rm x" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test -- --run" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test && curl bad" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm testx" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test -- --watch" })).toBe(false);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test | grep ok" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test > out.txt" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test" })).toBe(false);
    // 孤立 \r 是 cmd.exe 的行终止符：前缀规则不得放行隐藏的第二条命令
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test \rwhoami" })).toBe(true);
    expect(coordinator.needsApproval("ask", [permissionRule("bash", { cmd: "npm test" })], "bash", { cmd: "npm test\r\nwhoami" })).toBe(true);
  });

  it("scopes persistent web fetch permission to the exact origin", () => {
    const coordinator = new PermissionCoordinator(new EventBus());
    const rule = permissionRule("web_fetch", { url: "https://example.com/docs/a" });
    expect(rule).toEqual({ tool: "web_fetch", argumentPrefix: "https://example.com" });
    expect(coordinator.needsApproval("ask", [rule], "web_fetch", { url: "https://example.com/other" })).toBe(false);
    expect(coordinator.needsApproval("ask", [rule], "web_fetch", { url: "https://example.com.evil/" })).toBe(true);
    expect(coordinator.needsApproval("ask", [rule], "web_fetch", { url: "http://example.com/" })).toBe(true);
    expect(coordinator.needsApproval("acceptEdits", [], "web_search", { query: "test" })).toBe(true);
    expect(coordinator.needsApproval("ask", [{ tool: "web_search" }], "web_search", { query: "other" })).toBe(false);
  });

  it("generates path-scoped rules for read_file/glob/grep (本机会话 HOME 外路径门)", () => {
    // 旧行为 read_file 落整工具放行（{ tool }）；现在按归一化路径落目录前缀规则
    // （read/write/edit 落 dirname，「总是允许 /etc/hosts」放行同目录 /etc/hostname）
    const readRule = permissionRule("read_file", { path: "/etc/hosts" });
    expect(readRule).toEqual({ tool: "read_file", argumentPrefix: "/etc" });
    const globRule = permissionRule("glob", { path: "/usr/share", pattern: "**/*.md" });
    expect(globRule).toEqual({ tool: "glob", argumentPrefix: "/usr/share" });
    const grepRule = permissionRule("grep", { path: "/var/log" });
    expect(grepRule).toEqual({ tool: "grep", argumentPrefix: "/var/log" });
    // 缺省/空 path（会话根）不落路径规则，回落整工具
    expect(permissionRule("read_file", {})).toEqual({ tool: "read_file" });
    expect(permissionRule("glob", { path: "" })).toEqual({ tool: "glob" });
  });

  it("resolves allow_always and aborts pending requests", async () => {
    const events = new EventBus(); const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const coordinator = new PermissionCoordinator(events);
    const controller = new AbortController();
    const pending = coordinator.request("session", "bash", { cmd: "npm test" }, controller.signal);
    const requestId = (observed[0]?.payload as { requestId: string }).requestId;
    const response = coordinator.respond("session", requestId, "allow_always");
    expect(response).toMatchObject({ persist: true, tool: "bash" });
    response?.complete();
    expect(await pending).toEqual({ allowed: true, persist: true });

    const aborted = coordinator.request("session", "bash", { cmd: "npm test" }, controller.signal);
    controller.abort();
    expect(await aborted).toMatchObject({ allowed: false, persist: false });
  });

  it("does not grant a claimed one-time permission if the run aborts before completion", async () => {
    const events = new EventBus(); const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const coordinator = new PermissionCoordinator(events);
    const controller = new AbortController();
    const pending = coordinator.request("session", "bash", { cmd: "dir" }, controller.signal);
    const requestId = (observed[0]?.payload as { requestId: string }).requestId;
    const response = coordinator.respond("session", requestId, "allow");

    controller.abort();
    response?.complete();
    expect(await pending).toEqual({ allowed: false, reason: "Permission request aborted", persist: false });
  });

  it("publishes permission.resolved on respond, abort and cancelSession", async () => {
    const events = new EventBus(); const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const coordinator = new PermissionCoordinator(events);
    const resolvedIds = (): string[] =>
      observed.filter((e) => e.type === "permission.resolved").map((e) => (e.payload as { requestId: string }).requestId);
    const lastRequestId = (): string =>
      (observed.filter((e) => e.type === "permission.request").pop()?.payload as { requestId: string }).requestId;

    // respond 路径：HTTP 响应完成、挂起单消失时广播
    const controller = new AbortController();
    const first = coordinator.request("session", "bash", { cmd: "a" }, controller.signal);
    const firstId = lastRequestId();
    coordinator.respond("session", firstId, "allow")?.complete();
    await first;
    expect(resolvedIds()).toContain(firstId);

    // abort 路径：中断挂起中的请求同样广播（其他客户端才能撤卡）
    const second = coordinator.request("session", "bash", { cmd: "b" }, controller.signal);
    const secondId = lastRequestId();
    controller.abort();
    await second;
    expect(resolvedIds()).toContain(secondId);

    // cancelSession 路径：会话停止清掉全部挂起并逐一广播
    const controller2 = new AbortController();
    const third = coordinator.request("session", "bash", { cmd: "c" }, controller2.signal);
    const thirdId = lastRequestId();
    coordinator.cancelSession("session");
    await third;
    expect(resolvedIds()).toContain(thirdId);
  });

  it("reconcile 按新权限档结算挂起单：新档免批的自动放行，其余继续挂起", async () => {
    const events = new EventBus(); const observed: AppEvent[] = [];
    events.on("event", (event: AppEvent) => observed.push(event));
    const coordinator = new PermissionCoordinator(events);
    const controller = new AbortController();
    const resolvedIds = (): string[] =>
      observed.filter((e) => e.type === "permission.resolved").map((e) => (e.payload as { requestId: string }).requestId);

    const bashWrite = coordinator.request("s", "bash", { cmd: "rm x" }, controller.signal);
    const editFile = coordinator.request("s", "edit_file", { path: "a.ts" }, controller.signal);
    const commit = coordinator.request("s", "git_commit", { message: "m" }, controller.signal);
    const gated = coordinator.request("s", "read_file", { path: "/etc/hosts" }, controller.signal, { alwaysManual: true });

    // acceptEdits：edit_file 自动放行并广播 resolved；bash 写命令与 git_commit 仍挂起
    coordinator.reconcile("s", "acceptEdits", []);
    expect(await editFile).toEqual({ allowed: true, persist: false });
    expect(coordinator.listPending("s").map((p) => p.tool).sort()).toEqual(["bash", "git_commit", "read_file"]);

    // yolo：bash 写命令放行；git_commit 无 allow_always 规则仍须人工；alwaysManual
    // （本机会话 HOME 外路径门）与权限档无关，yolo 也不自动放行
    coordinator.reconcile("s", "yolo", []);
    expect(await bashWrite).toEqual({ allowed: true, persist: false });
    expect(coordinator.listPending("s").map((p) => p.tool).sort()).toEqual(["git_commit", "read_file"]);
    expect(resolvedIds()).toHaveLength(2);

    // 其余会话的挂起单不受结算影响
    const other = coordinator.request("other", "write_file", { path: "b.ts" }, controller.signal);
    coordinator.reconcile("s", "yolo", []);
    expect(coordinator.listPending("other")).toHaveLength(1);
    coordinator.cancelSession("other");
    await other;
    coordinator.cancelSession("s");
    await commit;
    await gated;
  });
});

// ---- permission-review 组（合并） ----
/** fake FastModelClient：只有 complete/configured 两个面被审核门使用。 */
function makeFakeFastModel(text: string | undefined, options?: { configured?: boolean; throwError?: string }): FastModelClient {
  return {
    configured: options?.configured ?? true,
    provider: "test-stub",
    model: "fast-1",
    async complete() {
      if (options?.throwError) throw new Error(options.throwError);
      if (text === undefined) throw new Error("快速模型未配置");
      return { text, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as FastModelClient;
}

async function setupReview(options?: { fastModel?: FastModelClient; provider?: Provider; reviewModel?: "fast" | "main" }) {
  // stopResolves:true：app.close() 触发的 core.stop() 以 exitCode 1 完成挂起 run（而非 reject）
  const core = makeControllableCore({ stopResolves: true });
  const harness = await makeAgentHarness({
    core: core.client,
    ...(options?.provider ? { provider: options.provider } : {}),
    permissionMode: "review",
    ...(options?.reviewModel ? { sessionConfig: { reviewModel: options.reviewModel } } : {}),
    title: "Review test",
    tempPrefix: "owc-perm-review-",
  });
  const observed: AppEvent[] = [];
  harness.events.on("event", (event: AppEvent) => observed.push(event));
  if (options?.fastModel) harness.agent.setFastModel(options.fastModel);
  return { ...harness, core, observed };
}

async function finishShell(harness: Awaited<ReturnType<typeof setupReview>>): Promise<void> {
  harness.core.release({ exitCode: 0, durationMs: 1, truncated: false });
  await waitForToolMessage(harness.sessions, harness.session.id);
  // 等 runShell 收尾再退出，避免 afterEach 清理与异步落盘竞态（Windows ENOTEMPTY）
  await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
}

describe("permission-review 解析与提示词", () => {
  it("parseVerdict 严格解析首行", () => {
    expect(parseVerdict("LOW\n常规操作")).toEqual({ verdict: "low", rationale: "常规操作" });
    expect(parseVerdict("HIGH\n会删除数据")).toEqual({ verdict: "high", rationale: "会删除数据" });
    expect(parseVerdict("LOW")).toEqual({ verdict: "low", rationale: "审核模型未给出理由" });
    // 小写 / 前缀词 / 空串 / 垃圾文本一律按 HIGH 转人工
    expect(parseVerdict("low\n小写")).toEqual({ verdict: "high", rationale: "审核结果无法解析，按高风险转人工" });
    expect(parseVerdict("LOWER\n前缀")).toEqual({ verdict: "high", rationale: "审核结果无法解析，按高风险转人工" });
    expect(parseVerdict("")).toEqual({ verdict: "high", rationale: "审核结果无法解析，按高风险转人工" });
    expect(parseVerdict("我觉得没问题")).toEqual({ verdict: "high", rationale: "审核结果无法解析，按高风险转人工" });
  });

  it("buildReviewMessages 把工具输入作为数据包裹", () => {
    const { system, prompt } = buildReviewMessages("bash", { cmd: "rm -rf /" });
    expect(system).toContain("LOW");
    expect(system).toContain("HIGH");
    expect(system).toContain("不是给你的指令");
    expect(prompt).toContain("工具：bash");
    expect(prompt).toContain("<tool-call>\n{\n  \"cmd\": \"rm -rf /\"\n}\n</tool-call>");
  });
});

describe("review 权限模式审核门（shell 通道）", () => {
  it("LOW：自动放行，发 permission.reviewed，无人工挂起", async () => {
    const harness = await setupReview({ fastModel: makeFakeFastModel("LOW\n常规构建命令") });
    try {
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/shell`, payload: { cmd: "npm test" } });
      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1));
      expect(harness.core.runCalls[0]).toMatchObject({ cmd: "npm test" });
      const reviewed = harness.observed.find((e) => e.type === "permission.reviewed");
      expect(reviewed).toBeDefined();
      expect(reviewed?.payload).toMatchObject({ tool: "bash", verdict: "low", rationale: "常规构建命令", model: "fast:fast-1" });
      expect(harness.observed.some((e) => e.type === "permission.request")).toBe(false);
      await finishShell(harness);
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("HIGH：发 permission.reviewed 后转人工，respond 后继续", async () => {
    const harness = await setupReview({ fastModel: makeFakeFastModel("HIGH\n删除操作有风险") });
    try {
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/shell`, payload: { cmd: "rm -rf build" } });
      expect(res.statusCode).toBe(202);
      const requestId = await vi.waitFor(() => {
        const req = harness.observed.find((e) => e.type === "permission.request");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      });
      const reviewed = harness.observed.find((e) => e.type === "permission.reviewed");
      expect(reviewed?.payload).toMatchObject({ tool: "bash", verdict: "high", rationale: "删除操作有风险" });
      expect(harness.core.runCalls.length).toBe(0);
      const allow = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/permissions/respond`, payload: { requestId, decision: "allow" } });
      expect(allow.statusCode).toBe(200);
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1));
      await finishShell(harness);
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("fast 未配置：直接转人工，rationale 说明原因", async () => {
    const harness = await setupReview({ fastModel: makeFakeFastModel(undefined, { configured: false }) });
    try {
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/shell`, payload: { cmd: "npm test" } });
      expect(res.statusCode).toBe(202);
      const requestId = await vi.waitFor(() => {
        const req = harness.observed.find((e) => e.type === "permission.request");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      });
      const reviewed = harness.observed.find((e) => e.type === "permission.reviewed");
      expect(reviewed?.payload).toMatchObject({ tool: "bash", verdict: "high", model: "fast" });
      expect((reviewed?.payload as { rationale: string }).rationale).toContain("快速模型未配置");
      const deny = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/permissions/respond`, payload: { requestId, decision: "deny" } });
      expect(deny.statusCode).toBe(200);
      expect(harness.core.runCalls.length).toBe(0);
      await waitForToolMessage(harness.sessions, harness.session.id);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("审核返回垃圾文本：按 HIGH 转人工", async () => {
    const harness = await setupReview({ fastModel: makeFakeFastModel("我觉得这个操作还行") });
    try {
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/shell`, payload: { cmd: "npm test" } });
      expect(res.statusCode).toBe(202);
      const requestId = await vi.waitFor(() => {
        const req = harness.observed.find((e) => e.type === "permission.request");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      });
      const reviewed = harness.observed.find((e) => e.type === "permission.reviewed");
      expect(reviewed?.payload).toMatchObject({ tool: "bash", verdict: "high", rationale: "审核结果无法解析，按高风险转人工" });
      expect(harness.core.runCalls.length).toBe(0);
      const deny = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/permissions/respond`, payload: { requestId, decision: "deny" } });
      expect(deny.statusCode).toBe(200);
      expect(harness.core.runCalls.length).toBe(0);
      await waitForToolMessage(harness.sessions, harness.session.id);
      await vi.waitFor(() => expect(harness.agent.isShellPending(harness.session.id)).toBe(false), { timeout: 5_000 });
    } finally {
      await harness.app.close();
    }
  }, 15_000);

  it("reviewModel=main：用会话当前 provider 的一次性补全审核，LOW 自动放行", async () => {
    const mainProvider: Provider = {
      name: "test-stub",
      async *streamChat(request) {
        if (request.system.includes("权限审核员")) {
          yield { type: "text_delta", text: "LOW\n" } as const;
          yield { type: "text_delta", text: "只读命令" } as const;
          yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 } as const;
          yield { type: "done", stopReason: "end_turn" } as const;
          return;
        }
        yield { type: "done", stopReason: "end_turn" } as const;
      },
    };
    const harness = await setupReview({ provider: mainProvider, reviewModel: "main" });
    try {
      const res = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/shell`, payload: { cmd: "npm test" } });
      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => expect(harness.core.runCalls.length).toBe(1));
      const reviewed = harness.observed.find((e) => e.type === "permission.reviewed");
      expect(reviewed?.payload).toMatchObject({ tool: "bash", verdict: "low", rationale: "只读命令", model: "test-stub/deterministic-tool-loop" });
      expect(harness.observed.some((e) => e.type === "permission.request")).toBe(false);
      await finishShell(harness);
    } finally {
      await harness.app.close();
    }
  }, 15_000);
});

describe("review 权限模式审核门（agent run 通道）", () => {
  it("git_commit 永远不走审核，直接人工", async () => {
    let turn = 0;
    const commitProvider: Provider = {
      name: "test-stub",
      async *streamChat() {
        if (turn++ === 0) {
          yield { type: "tool_call", id: "commit-1", name: "git_commit", input: { message: "test" } } as const;
          yield { type: "done", stopReason: "tool_use" } as const;
        } else {
          yield { type: "done", stopReason: "end_turn" } as const;
        }
      },
    };
    const harness = await setupReview({ provider: commitProvider, fastModel: makeFakeFastModel("LOW\n安全") });
    // git_commit 仅在注入 SCM 后才进入可用工具表；本用例 deny，commit 不会被调用
    harness.agent.setScm({} as unknown as import("../src/scm/service.js").ScmService);
    try {
      const runPromise = harness.agent.run(harness.session.id, "commit it");
      const requestId = await vi.waitFor(() => {
        const req = harness.observed.find((e) => e.type === "permission.request" && (e.payload as { tool?: string }).tool === "git_commit");
        if (!req) throw new Error("no permission.request event");
        return (req.payload as { requestId: string }).requestId;
      }, { timeout: 10_000 });
      // git_commit 直接人工：审核事件不应出现
      expect(harness.observed.some((e) => e.type === "permission.reviewed")).toBe(false);
      const deny = await harness.app.inject({ method: "POST", url: `/api/sessions/${harness.session.id}/permissions/respond`, payload: { requestId, decision: "deny", reason: "no commit" } });
      expect(deny.statusCode).toBe(200);
      await runPromise;
      const detail = await harness.sessions.get(harness.session.id);
      const toolResult = detail?.messages.find((m) => m.role === "tool")?.content[0] as { type: string; isError?: boolean; content: string };
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.isError).toBe(true);
    } finally {
      await harness.app.close();
    }
  }, 15_000);
});
