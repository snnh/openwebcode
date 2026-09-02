import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner, isContextOverflowError } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { alignCompactionBoundary, Compactor, COMPACT_OVERVIEW_SYSTEM, COMPACT_TOOLCALLS_SYSTEM, extractInstructions, validateCompactionOutput } from "../src/context/compactor.js";
import { ContextManager, compactionIndexIn, recordCompaction } from "../src/context/context-manager.js";
import { estimateMessageTokens } from "../src/context/model-profile.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import type { FastModelClient } from "../src/fast-model.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { activePathMessages } from "../src/sessions/session-tree.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { UsageLog } from "../src/usage-log.js";
import { makeFakeFastModel } from "./helpers/fake-fast-model.js";
import { tempRoot } from "./helpers/temp-roots.js";

const EMPTY_FAST_MODEL = { configured: false, provider: undefined, model: undefined, setConfig() { /* noop */ } } as unknown as FastModelClient;

/** 已配置但 complete 一律抛错的快速模型：模拟压缩时模型调用失败。 */
function makeThrowingFastModel(): FastModelClient {
  return {
    configured: true,
    provider: "fast-provider",
    model: "fake-cheap-model",
    setConfig() { /* noop */ },
    async complete() {
      throw new Error("fast model unavailable");
    },
  } as unknown as FastModelClient;
}

/** 已配置的序列快速模型：按数组顺序逐次返回 text，超出后用最后一项兜底（校验重试用例用）。 */
function makeSequenceFastModel(outputs: string[], calls?: Array<{ system: string; prompt: string }>): FastModelClient {
  let index = 0;
  return {
    configured: true,
    provider: "fast-provider",
    model: "fake-cheap-model",
    setConfig() { /* noop */ },
    async complete(input: { system: string; prompt: string }) {
      calls?.push(input);
      const text = outputs[Math.min(index, outputs.length - 1)]!;
      index += 1;
      return { text, usage: { inputTokens: 120, outputTokens: 30 } };
    },
  } as unknown as FastModelClient;
}

async function sessionWithMessages(store: SessionStore, count: number): Promise<string> {
  const session = await store.create({ cwd: os.tmpdir(), provider: "test-stub", title: "压缩样例" });
  for (let index = 0; index < count; index += 1) {
    await store.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `消息 ${index + 1}` }]);
  }
  return session.id;
}

describe("extractInstructions", () => {
  it("parses the 用户明确指令 section", () => {
    const text = "目标：\n- 做压缩\n\n用户明确指令：\n- 不许删文件\n- 用中文回复\n\n未决事项：\n- 无\n";
    expect(extractInstructions(text)).toEqual(["不许删文件", "用中文回复"]);
    expect(extractInstructions("目标：\n- 无指令")).toEqual([]);
  });
});

describe("validateCompactionOutput", () => {
  it("复述型输出（含转录角色标记）各模式判失败", () => {
    expect(validateCompactionOutput("overview", "【user】\n消息 1\n【assistant】\n消息 2", 100)).toContain("复述");
    expect(validateCompactionOutput("toolcalls", "【system】\n工具结果原文", 100)).toContain("复述");
  });

  it("合规 overview / toolcalls 输出通过；未按格式判失败", () => {
    expect(validateCompactionOutput("overview", "目标：\n- 压缩\n行动：\n- 执行\n关键发现：\n- 摘要", 100)).toBeUndefined();
    expect(validateCompactionOutput("toolcalls", "- [工具] bash → 完成\n- [用户] 要点", 100)).toBeUndefined();
    // 小节不足 3 个
    expect(validateCompactionOutput("overview", "目标：\n- 压缩\n行动：\n- 执行", 100)).toContain("格式");
    // 占位行不足半数
    expect(validateCompactionOutput("toolcalls", "- [工具] bash → 完成\n原文行 1\n原文行 2", 100)).toContain("格式");
  });

  it("长度兜底：转录 ≥ 4000 且摘要接近原文长度判未压缩；短转录不触发比率", () => {
    const sections = "目标：\n- a\n行动：\n- b\n关键发现：\n- c\n";
    // 转录 10_000 字符、摘要 8_500 字符（> 0.8 比率）→ 未压缩
    expect(validateCompactionOutput("overview", sections + "x".repeat(8_500), 10_000)).toContain("未压缩");
    // 相同摘要但转录短（< 4000）→ 比率不触发，格式合规即通过
    expect(validateCompactionOutput("overview", sections + "x".repeat(500), 500)).toBeUndefined();
  });
});

describe("Compactor", () => {
  it("does not summarize messages hidden by a newer clear boundary", async () => {
    const root = await tempRoot("owc-compact-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 10);
    await new ContextManager(store.contextRoot(id)).markCleared(5);
    const calls: Array<{ system: string; prompt: string }> = [];
    const compactor = new Compactor(store, makeFakeFastModel("目标：\n- 新上下文\n行动：\n- 跳过清除边界前的消息\n关键发现：\n- 清除边界生效", calls), {}, 2);
    await compactor.compact(id, "overview");
    expect(calls[0]!.prompt).not.toContain("消息 1\n");
    expect(calls[0]!.prompt).toContain("消息 6");
  });

  it("overview compacts the prefix and pins accumulated instructions in the view", async () => {
    const root = await tempRoot("owc-compact-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const calls: Array<{ system: string; prompt: string }> = [];
    const usageLog = new UsageLog(root);
    const compactor = new Compactor(store, makeFakeFastModel("目标：\n- 测试\n行动：\n- 压缩前缀\n修改文件：\n- 无\n用户明确指令：\n- 用中文\n", calls), { usageLog }, 10);

    const result = await compactor.compact(id, "overview");
    expect(result).toMatchObject({ changed: true, mode: "overview", uptoIndex: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("消息 1");

    const context = new ContextManager(store.contextRoot(id));
    const detail = (await store.get(id))!;
    const view = await context.buildView(detail.messages);
    expect(view.messages[0]).toMatchObject({ role: "user" });
    expect(view.messages[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("用户明确指令（跨段累积") });
    expect(view.messages[0]!.content[0]).toMatchObject({ text: expect.stringContaining("- 用中文") });
    expect(view.messages).toHaveLength(1 + 10);
    // 快速模型用量按实际服务商/模型进入报表
    const report = await usageLog.report();
    expect(report.sessions[0]?.providers[0]).toMatchObject({ provider: "fast-provider", model: "fake-cheap-model", inputTokens: 120 });

    // 第二次压缩：指令累积且去重；既有摘要（第一次的概览全文）进入快速模型提示词承接（F1）
    await store.appendMessage(id, "user", [{ type: "text", text: "消息 16" }]);
    const second = await compactor.compact(id, "overview");
    expect(second.changed).toBe(true);
    expect(calls[1]!.prompt).toContain("既有摘要");
    expect(calls[1]!.prompt).toContain("压缩前缀");
    const ledger = await context.load();
    expect(ledger.compacted?.instructions).toEqual(["用中文"]);
    // 记录以消息 id 锚定边界（F5）
    const detail2 = (await store.get(id))!;
    const active2 = activePathMessages(detail2.messages, detail2.activeLeafId);
    expect(ledger.compacted?.uptoMessageId).toBe(active2[second.uptoIndex! - 1]!.id);
    expect(compactionIndexIn(active2, ledger.compacted!)).toBe(second.uptoIndex);
  });

  it("有分叉时按活动路径计算压缩区段：摘要不混入废弃分支，keepTail 保留活动路径尾部", async () => {
    const root = await tempRoot("owc-compact-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: os.tmpdir(), provider: "test-stub", title: "分叉压缩" });
    const m1 = await store.appendMessage(session.id, "user", [{ type: "text", text: "主线 1" }]);
    await store.appendMessage(session.id, "assistant", [{ type: "text", text: "主线 2" }]);
    await store.appendMessage(session.id, "user", [{ type: "text", text: "废弃分支 3" }]);
    await store.appendMessage(session.id, "assistant", [{ type: "text", text: "废弃分支 4" }]);
    // 回到「主线 1」分叉：活动路径 = 主线 1 + 分支 5..8（共 5 条），主线 2 与废弃 3/4 留在 jsonl 全量里
    await store.setActiveLeaf(session.id, m1.id);
    await store.appendMessage(session.id, "assistant", [{ type: "text", text: "分支 5" }]);
    await store.appendMessage(session.id, "user", [{ type: "text", text: "分支 6" }]);
    await store.appendMessage(session.id, "assistant", [{ type: "text", text: "分支 7" }]);
    await store.appendMessage(session.id, "user", [{ type: "text", text: "分支 8" }]);

    const calls: Array<{ system: string; prompt: string }> = [];
    const compactor = new Compactor(store, makeFakeFastModel("目标：\n- 分叉摘要\n行动：\n- 按活动路径压缩\n关键发现：\n- 摘要只含活动路径", calls), {}, 2);
    const result = await compactor.compact(session.id, "overview");

    // 活动路径 5 条，keepTail=2 → 压缩前 3 条（若按 jsonl 全量 8 条算会错位到 uptoIndex=6）
    expect(result).toMatchObject({ changed: true, uptoIndex: 3 });
    // 摘要只含活动路径区段，不混入废弃分支
    expect(calls[0]!.prompt).toContain("主线 1");
    expect(calls[0]!.prompt).toContain("分支 6");
    expect(calls[0]!.prompt).not.toContain("废弃分支");
    expect(calls[0]!.prompt).not.toContain("主线 2");

    // buildView 应用到活动路径：keepTail 保护的尾部（含最后用户消息）必须保留
    const detail = (await store.get(session.id))!;
    const active = activePathMessages(detail.messages, detail.activeLeafId);
    const view = await new ContextManager(store.contextRoot(session.id)).buildView(active);
    expect(view.messages).toHaveLength(1 + 2);
    const viewText = view.messages.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join("")).join("\n");
    expect(viewText).toContain("分支 7");
    expect(viewText).toContain("分支 8");
    expect(viewText).not.toContain("废弃分支");
  });

  it("falls back to rule-based toolcalls without a fast model; overview requires it unless forced", async () => {
    const root = await tempRoot("owc-compact-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: os.tmpdir(), provider: "test-stub", title: "压缩样例" });
    // 工具消息放最前，确保落在压缩区段内
    await store.appendMessage(session.id, "assistant", [
      { type: "tool_call", id: "t1", name: "bash", input: { cmd: "npm test" } },
    ]);
    await store.appendMessage(session.id, "tool", [{ type: "tool_result", toolCallId: "t1", content: "ok" }]);
    for (let index = 0; index < 15; index += 1) {
      await store.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `消息 ${index + 1}` }]);
    }
    const compactor = new Compactor(store, EMPTY_FAST_MODEL, {}, 10);

    await expect(compactor.compact(session.id, "overview")).rejects.toThrow(/快速模型未配置/);

    const toolcalls = await compactor.compact(session.id, "toolcalls");
    expect(toolcalls).toMatchObject({ changed: true, mode: "toolcalls" });
    expect(toolcalls.summary).toContain("[规则压缩]");
    expect(toolcalls.summary).toContain("bash");

    // 区段耗尽后不再重复压缩
    const again = await compactor.compact(session.id, "toolcalls");
    expect(again.changed).toBe(false);
  });

  it("forced overview without a fast model degrades to truncated and clears pins", async () => {
    const root = await tempRoot("owc-compact-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const context = new ContextManager(store.contextRoot(id));
    // load() 返回缓存规范副本（只读约定）：突变前先克隆再 save
    const ledger = structuredClone(await context.load());
    ledger.entries.push({ messageId: "m", kind: "tool_result", artifactId: "a", state: "restored", createdRound: 0, pinnedUntilRound: 99 });
    await context.save(ledger);

    const compactor = new Compactor(store, EMPTY_FAST_MODEL, {}, 10);
    const result = await compactor.compact(id, "overview", { forced: true });
    expect(result.mode).toBe("truncated");
    expect((await context.load()).entries[0]?.pinnedUntilRound).toBe(0);
  });

  it("forced 压缩时快速模型抛错 → 规则降级兜底（mode=truncated），压缩照常完成并写账本", async () => {
    const root = await tempRoot("owc-compact-degrade-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const compactor = new Compactor(store, makeThrowingFastModel(), {}, 10);

    const result = await compactor.compact(id, "overview", { forced: true });
    expect(result).toMatchObject({ changed: true, mode: "truncated" });
    expect(result.summary).toContain("[规则压缩]");
    expect(result.uptoIndex).toBe(5);

    // 规则摘要与降级 mode 写进账本（与返回结果同一条记录）
    const ledger = await new ContextManager(store.contextRoot(id)).load();
    expect(ledger.compacted).toMatchObject({ mode: "truncated", uptoIndex: 5, summary: result.summary });
  });

  it("非 forced 压缩时快速模型抛错 → 维持抛错（手动 /compact 让用户知情），账本无记录", async () => {
    const root = await tempRoot("owc-compact-throw-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const compactor = new Compactor(store, makeThrowingFastModel(), {}, 10);

    await expect(compactor.compact(id, "overview")).rejects.toThrow("fast model unavailable");
    await expect(compactor.compact(id, "toolcalls")).rejects.toThrow("fast model unavailable");
    const ledger = await new ContextManager(store.contextRoot(id)).load();
    expect(ledger.compacted).toBeUndefined();
  });

  it("首次输出复述原文 → 追加纠偏指令重试一次 → 合规摘要写账本", async () => {
    const root = await tempRoot("owc-compact-retry-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const calls: Array<{ system: string; prompt: string }> = [];
    const verbatim = "【user】\n消息 1\n【assistant】\n消息 2";
    const good = "目标：\n- 压缩\n行动：\n- 生成概览\n关键发现：\n- 完成";
    const compactor = new Compactor(store, makeSequenceFastModel([verbatim, good], calls), {}, 10);

    const result = await compactor.compact(id, "overview");
    expect(result).toMatchObject({ changed: true, mode: "overview", uptoIndex: 5 });
    // 调了两次 complete：首次复述被拦，第二次纠偏后合规
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toBe(COMPACT_OVERVIEW_SYSTEM);
    expect(calls[1]!.system).toContain("上次输出不合格");
    expect(calls[1]!.system).toContain("复述");
    // 账本记录合规摘要而非复述原文（uptoIndex 已前进，绝不允许原文落账）
    const ledger = await new ContextManager(store.contextRoot(id)).load();
    expect(ledger.compacted).toMatchObject({ mode: "overview", summary: good });
  });

  it("两次都复述 + forced → 规则降级 truncated（账本照常记录）", async () => {
    const root = await tempRoot("owc-compact-retry-force-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const calls: Array<{ system: string; prompt: string }> = [];
    const verbatim = "【user】\n消息 1\n【assistant】\n消息 2";
    const compactor = new Compactor(store, makeSequenceFastModel([verbatim, verbatim], calls), {}, 10);

    const result = await compactor.compact(id, "overview", { forced: true });
    expect(result).toMatchObject({ changed: true, mode: "truncated", uptoIndex: 5 });
    expect(result.summary).toContain("[规则压缩]");
    expect(calls).toHaveLength(2);
    const ledger = await new ContextManager(store.contextRoot(id)).load();
    expect(ledger.compacted).toMatchObject({ mode: "truncated", uptoIndex: 5 });
  });

  it("两次都复述 + 非 forced → 抛错（账本无记录）", async () => {
    const root = await tempRoot("owc-compact-retry-throw-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const calls: Array<{ system: string; prompt: string }> = [];
    const verbatim = "【user】\n消息 1\n【assistant】\n消息 2";
    const compactor = new Compactor(store, makeSequenceFastModel([verbatim, verbatim], calls), {}, 10);

    await expect(compactor.compact(id, "overview")).rejects.toThrow(/未通过校验/);
    expect(calls).toHaveLength(2);
    const ledger = await new ContextManager(store.contextRoot(id)).load();
    expect(ledger.compacted).toBeUndefined();
  });

  it("complete 收到注入 getter 的 maxTokens；改 getter 值后下次压缩用新值（热生效语义）", async () => {
    const root = await tempRoot("owc-compact-maxtokens-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const calls: Array<{ system: string; prompt: string; maxTokens?: number }> = [];
    const compactor = new Compactor(store, makeFakeFastModel("目标：\n- 摘要\n行动：\n- 压缩前缀\n修改文件：\n- 无", calls), {}, 10);
    let maxTokens = 32_000;
    compactor.setCompactMaxTokens(() => maxTokens);

    await compactor.compact(id, "overview");
    expect(calls[0]?.maxTokens).toBe(32_000);

    // 热生效：改 getter 返回值，下一次压缩立即用新上限（无需重启）
    await store.appendMessage(id, "user", [{ type: "text", text: "再补一条" }]);
    maxTokens = 128_000;
    await compactor.compact(id, "overview");
    expect(calls[1]?.maxTokens).toBe(128_000);
  });

  it("promptOverrides 注入覆盖压缩系统提示词，缺省回退内置", async () => {
    const root = await tempRoot("owc-compact-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const calls: Array<{ system: string; prompt: string }> = [];
    const compactor = new Compactor(store, makeFakeFastModel("目标：\n- 测试\n行动：\n- 压缩前缀\n修改文件：\n- 无\n", calls), {}, 10);

    // 默认：使用内置 overview 系统提示
    await compactor.compact(id, "overview");
    expect(calls.at(-1)?.system).toBe(COMPACT_OVERVIEW_SYSTEM);

    // 注入覆盖：overview 模式使用覆盖文本
    await store.appendMessage(id, "user", [{ type: "text", text: "再来一条" }]);
    await compactor.compact(id, "overview", { promptOverrides: { overview: "自定义概览压缩指令" } });
    expect(calls.at(-1)?.system).toBe("自定义概览压缩指令");
  });

  it("toolcalls 模式的提示词覆盖只在配置了快速模型时生效", async () => {
    const root = await tempRoot("owc-compact-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: os.tmpdir(), provider: "test-stub", title: "压缩样例" });
    await store.appendMessage(session.id, "assistant", [
      { type: "tool_call", id: "t1", name: "bash", input: { cmd: "npm test" } },
    ]);
    await store.appendMessage(session.id, "tool", [{ type: "tool_result", toolCallId: "t1", content: "ok" }]);
    for (let index = 0; index < 15; index += 1) {
      await store.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `消息 ${index + 1}` }]);
    }
    const calls: Array<{ system: string; prompt: string }> = [];
    const compactor = new Compactor(store, makeFakeFastModel("- [工具] bash → 完成", calls), {}, 10);

    await compactor.compact(session.id, "toolcalls", { promptOverrides: { toolcalls: "自定义工具压缩指令" } });
    expect(calls[0]?.system).toBe("自定义工具压缩指令");
    // 未注入时回退内置
    for (let index = 0; index < 12; index += 1) {
      await store.appendMessage(session.id, "user", [{ type: "text", text: `追加 ${index + 1}` }]);
    }
    await compactor.compact(session.id, "toolcalls");
    expect(calls.at(-1)?.system).toBe(COMPACT_TOOLCALLS_SYSTEM);
  });
});

describe("Compactor 二次压缩承接既有摘要（F1）", () => {
  it("快速模型路径：第二次压缩的提示词含既有摘要，视图保留第一纪元要点", async () => {
    const root = await tempRoot("owc-compact-merge-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const calls: Array<{ system: string; prompt: string }> = [];
    const epoch1 = "目标：\n- 第一纪元目标\n行动：\n- 早期行动\n关键发现：\n- 第一纪元结论\n用户明确指令：\n- 用中文\n";
    const epoch2 = "目标：\n- 第一纪元目标\n行动：\n- 早期行动 + 新行动\n关键发现：\n- 第一纪元结论\n- 第二纪元新发现\n未决事项：\n- 无\n用户明确指令：\n- 用中文\n";
    const compactor = new Compactor(store, makeSequenceFastModel([epoch1, epoch2], calls), {}, 10);

    await compactor.compact(id, "overview");
    await store.appendMessage(id, "user", [{ type: "text", text: "消息 16" }]);
    const second = await compactor.compact(id, "overview");
    expect(second.changed).toBe(true);

    // 第二次调用把第一纪元摘要作为「既有摘要」送入提示词（承接而非丢弃）
    expect(calls[1]!.prompt).toContain("既有摘要");
    expect(calls[1]!.prompt).toContain("第一纪元结论");
    // 视图的摘要头是第二次压缩的产物：合并后仍含第一纪元要点
    const detail = (await store.get(id))!;
    const view = await new ContextManager(store.contextRoot(id)).buildView(activePathMessages(detail.messages, detail.activeLeafId));
    const viewText = view.messages.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join("")).join("\n");
    expect(viewText).toContain("第一纪元结论");
    expect(viewText).toContain("第二纪元新发现");
  });

  it("规则降级路径：第二次压缩的摘要截段置顶承接既有摘要", async () => {
    const root = await tempRoot("owc-compact-merge-rule-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 15);
    const compactor = new Compactor(store, EMPTY_FAST_MODEL, {}, 10);

    const first = await compactor.compact(id, "toolcalls");
    expect(first.summary).toContain("早前 5 条消息要点");
    await store.appendMessage(id, "user", [{ type: "text", text: "消息 16" }]);
    await store.appendMessage(id, "user", [{ type: "text", text: "消息 17" }]);
    const second = await compactor.compact(id, "toolcalls");
    expect(second.changed).toBe(true);
    // 规则路径无模型归并：既有摘要原文截段承接（第一纪元的行仍在）
    expect(second.summary).toContain("既有摘要（早前压缩）");
    expect(second.summary).toContain("早前 5 条消息要点");
    // 新区段要点同样在内（规则压缩只收 user 消息：区段 [5,7) 中的用户消息是「消息 7」）
    expect(second.summary).toContain("消息 7");
  });
});

describe("alignCompactionBoundary（F2 工具批次对齐）", () => {
  const text = (id: string, role: ChatMessage["role"] = "user"): ChatMessage => ({ id, role, content: [{ type: "text", text: id }], createdAt: new Date(0).toISOString() });
  const call = (id: string, callId: string): ChatMessage => ({ id, role: "assistant", content: [{ type: "tool_call", id: callId, name: "bash", input: { cmd: "true" } }], createdAt: new Date(0).toISOString() });
  const result = (id: string, callId: string): ChatMessage => ({ id, role: "tool", content: [{ type: "tool_result", toolCallId: callId, content: "ok" }], createdAt: new Date(0).toISOString() });

  it("无工具调用时边界不变；越界钳制到 [0, length]", () => {
    const messages = [text("a"), text("b", "assistant"), text("c")];
    expect(alignCompactionBoundary(messages, 2)).toBe(2);
    expect(alignCompactionBoundary(messages, 99)).toBe(3);
    expect(alignCompactionBoundary(messages, -1)).toBe(0);
  });

  it("边界截断批次（结果在界外）→ 收缩到调用之前", () => {
    const messages = [text("u1"), call("a1", "t1"), result("r1", "t1"), text("u2")];
    // uptoIndex=2 → 前缀含 a1 的调用（index 1）但 r1（index 2）在界外 → 收缩到 a1 之前
    expect(alignCompactionBoundary(messages, 2)).toBe(1);
    // 边界含完整批次（调用与结果都在前缀内）→ 不变
    expect(alignCompactionBoundary(messages, 3)).toBe(3);
    expect(alignCompactionBoundary(messages, 4)).toBe(4);
  });

  it("级联收缩：收缩后暴露的更早跨界批次一并排除", () => {
    // 两个调用集中在前、结果集中在后：任何落在结果之前的边界都会连环收缩
    const messages = [call("a1", "t1"), call("a2", "t2"), result("r1", "t1"), result("r2", "t2"), text("u")];
    // 前缀 [0,3) 含 t2 调用（index 1）但结果（index 3）在界外 → 收到 1；t1 结果（index 2）又 ≥ 1 → 收到 0
    expect(alignCompactionBoundary(messages, 3)).toBe(0);
    // 前缀 [0,4) 含全部调用与结果 → 不变
    expect(alignCompactionBoundary(messages, 4)).toBe(4);
    expect(alignCompactionBoundary(messages, 5)).toBe(5);
  });

  it("调用无结果（中断轮残留）不算跨界，边界不变", () => {
    const messages = [text("u1"), call("a1", "t1"), text("u2")];
    expect(alignCompactionBoundary(messages, 3)).toBe(3);
    expect(alignCompactionBoundary(messages, 2)).toBe(2);
  });
});

describe("Compactor 边界保护（F2）", () => {
  it("压缩区段不截断工具批次：uptoIndex 对齐到调用之前", async () => {
    const root = await tempRoot("owc-compact-align-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: os.tmpdir(), provider: "test-stub", title: "批次对齐" });
    for (let index = 0; index < 9; index += 1) {
      await store.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `消息 ${index + 1}` }]);
    }
    // index 9 = assistant(tool_call)，index 10 = tool 结果，index 11 = user
    await store.appendMessage(session.id, "assistant", [{ type: "tool_call", id: "t1", name: "bash", input: { cmd: "npm test" } }]);
    await store.appendMessage(session.id, "tool", [{ type: "tool_result", toolCallId: "t1", content: "ok" }]);
    await store.appendMessage(session.id, "user", [{ type: "text", text: "尾部" }]);

    const compactor = new Compactor(store, EMPTY_FAST_MODEL, {}, 2);
    // keepTail=2 → uptoIndex 10 会把调用（index 9）与结果（index 10）截断 → 对齐到 9
    const compacted = await compactor.compact(session.id, "toolcalls");
    expect(compacted).toMatchObject({ changed: true, uptoIndex: 9 });

    // 视图中不留孤儿 tool_result：批次整体保留在压缩边界之后
    const detail = (await store.get(session.id))!;
    const view = await new ContextManager(store.contextRoot(session.id)).buildView(activePathMessages(detail.messages, detail.activeLeafId));
    const ids = view.messages.map((message) => message.id);
    const callIndex = view.messages.findIndex((message) => message.content.some((block) => block.type === "tool_call"));
    const resultIndex = view.messages.findIndex((message) => message.content.some((block) => block.type === "tool_result"));
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBe(callIndex + 1);
    expect(ids[0]).toMatch(/^compaction:/);
  });

  it("protectFromMessageId：压缩区段不包含触发消息及其之后内容；区段被截空时 changed:false", async () => {
    const root = await tempRoot("owc-compact-protect-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: os.tmpdir(), provider: "test-stub", title: "触发保护" });
    const ids: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      ids.push((await store.appendMessage(session.id, "user", [{ type: "text", text: `消息 ${index + 1}` }])).id);
    }
    const compactor = new Compactor(store, EMPTY_FAST_MODEL, {}, 2);

    // 正常 uptoIndex = 13；保护 index 5 的消息 → 压缩区段收窄为 [0, 5)
    const clamped = await compactor.compact(session.id, "toolcalls", { protectFromMessageId: ids[5] });
    expect(clamped).toMatchObject({ changed: true, uptoIndex: 5 });
    // 触发消息（index 5）仍在视图中
    const detail = (await store.get(session.id))!;
    const view = await new ContextManager(store.contextRoot(session.id)).buildView(activePathMessages(detail.messages, detail.activeLeafId));
    expect(view.messages.some((message) => message.id === ids[5])).toBe(true);

    // 保护已压缩边界之前的首条消息 → 新区段为空 → changed:false 且原因可读
    const empty = await compactor.compact(session.id, "toolcalls", { protectFromMessageId: ids[0] });
    expect(empty.changed).toBe(false);
    expect(empty.reason).toContain("触发消息");
  });
});

describe("压缩记录的消息 id 锚定（F5）", () => {
  it("分叉到压缩边界之下：新分支内容完整可见，不靠下标误伤", async () => {
    const root = await tempRoot("owc-compact-fork-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: os.tmpdir(), provider: "test-stub", title: "分叉锚定" });
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      ids.push((await store.appendMessage(session.id, "user", [{ type: "text", text: `主线 ${index + 1}` }])).id);
    }
    // keepTail=2 → 压缩 [0, 8)，边界消息 = ids[7]
    const compactor = new Compactor(store, EMPTY_FAST_MODEL, {}, 2);
    const compacted = await compactor.compact(session.id, "toolcalls");
    expect(compacted).toMatchObject({ changed: true, uptoIndex: 8 });
    const ledger = await new ContextManager(store.contextRoot(session.id)).load();
    expect(ledger.compacted?.uptoMessageId).toBe(ids[7]);

    // 分叉到边界之下（ids[2]）：新分支内容全部可见，视图不裁剪、不注入旧摘要头
    await store.setActiveLeaf(session.id, ids[2]!);
    await store.appendMessage(session.id, "assistant", [{ type: "text", text: "分支甲" }]);
    await store.appendMessage(session.id, "user", [{ type: "text", text: "分支乙" }]);
    const detail = (await store.get(session.id))!;
    const active = activePathMessages(detail.messages, detail.activeLeafId);
    const view = await new ContextManager(store.contextRoot(session.id)).buildView(active);
    expect(view.messages).toHaveLength(5);
    const viewText = view.messages.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join("")).join("\n");
    expect(viewText).toContain("主线 1");
    expect(viewText).toContain("分支甲");
    expect(viewText).toContain("分支乙");
    expect(view.messages.some((message) => message.id.startsWith("compaction:"))).toBe(false);

    // 边界之上的分叉不受影响：边界消息在路径上时仍按锚点裁剪
    await store.setActiveLeaf(session.id, ids[8]!);
    await store.appendMessage(session.id, "user", [{ type: "text", text: "续走主线" }]);
    const detail2 = (await store.get(session.id))!;
    const active2 = activePathMessages(detail2.messages, detail2.activeLeafId);
    const view2 = await new ContextManager(store.contextRoot(session.id)).buildView(active2);
    // header + 主线 9（分叉点）+ 续走主线 = 3 条；摘要头之外的可见消息不含被压缩的主线前缀
    expect(view2.messages).toHaveLength(3);
    expect(view2.messages[0]!.id).toMatch(/^compaction:/);
    const tailText = view2.messages.slice(1).map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join("")).join("\n");
    expect(tailText).not.toContain("主线 1");
    expect(tailText).toContain("主线 9");
    expect(tailText).toContain("续走主线");
  });

  it("旧记录（无 uptoMessageId）回退 uptoIndex 下标语义", async () => {
    const root = await tempRoot("owc-compact-legacy-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 10);
    const context = new ContextManager(store.contextRoot(id));
    await context.updateLedger((ledger) => {
      recordCompaction(ledger, {
        uptoIndex: 5,
        mode: "toolcalls",
        summary: "- [用户] 旧摘要",
        instructions: [],
        createdAt: new Date().toISOString(),
      });
    });
    const detail = (await store.get(id))!;
    const view = await context.buildView(activePathMessages(detail.messages, detail.activeLeafId));
    expect(view.messages).toHaveLength(1 + 5);
    expect(view.messages[0]!.id).toMatch(/^compaction:/);
    const viewText = view.messages.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join("")).join("\n");
    expect(viewText).not.toContain("消息 1\n");
    expect(viewText).toContain("消息 6");
  });
});

describe("85% watermark forced compaction", () => {
  it("force-compacts before the provider call when utilization hits 0.85", async () => {
    const root = await tempRoot("owc-compact-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "anthropic",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const compactor = new Compactor(sessions, makeFakeFastModel("目标：\n- 压缩早期对话\n行动：\n- 强制压缩\n关键发现：\n- 水位达 85%", []), {}, 2);
    const tinyWindow = () => ({ contextWindow: 100, capabilities: { modalities: ["text"], thinking: ["disabled"], effort: [] } }) as never;
    const runner = new AgentRunner(sessions, providers, core, events, pricing, undefined, "zh-CN", 50, tinyWindow, undefined, undefined, undefined, compactor);
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息，".repeat(30) }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复，".repeat(30) }]);

    await runner.run(session.id, "新的问题，".repeat(30));

    const compactedEvents = published.filter((event) => event.type === "context.compacted");
    expect(compactedEvents).toHaveLength(1);
    expect(compactedEvents[0]?.payload).toMatchObject({ forced: true });
    // 开始事件先于完成事件：UI 据此给出「正在压缩」即时反馈
    const compactingEvents = published.filter((event) => event.type === "context.compacting");
    expect(compactingEvents).toHaveLength(1);
    expect(compactingEvents[0]?.payload).toMatchObject({ forced: true, mode: "overview" });
    expect(published.findIndex((event) => event.type === "context.compacting")).toBeLessThan(published.findIndex((event) => event.type === "context.compacted"));
    // provider 收到的视图首条是压缩摘要而非原始消息
    expect(requests.at(-1)?.messages[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Earlier context compacted") });
  });

  it("setCompactionThreshold 下调水位后提前触发强制压缩（默认 85 不触发）", async () => {
    const root = await tempRoot("owc-compact-threshold-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const provider: Provider = {
      name: "anthropic",
      async *streamChat() {
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    providers.register(provider);
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;

    // 第一轮：超大窗口 + 不注入阈值（默认 85），用与第二轮完全一致的消息量出确定的 token 估算值
    const probeRunner = new AgentRunner(sessions, providers, core, events, pricing, undefined, "zh-CN", 50,
      () => ({ contextWindow: 1_000_000, capabilities: { modalities: ["text"], thinking: ["disabled"], effort: [] } }) as never);
    const probe = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(probe.id, "user", [{ type: "text", text: "很早的消息，".repeat(30) }]);
    await sessions.appendMessage(probe.id, "assistant", [{ type: "text", text: "很早的回复，".repeat(30) }]);
    await probeRunner.run(probe.id, "探针消息".repeat(20));
    const probeWatermark = published.find((event) => event.type === "context.watermark");
    const estimated = (probeWatermark?.payload as { estimatedTokens: number }).estimatedTokens;
    expect(estimated).toBeGreaterThan(0);

    // 第二轮：同样的消息规模，窗口定到 utilization ≈ 0.70（高于 60、低于默认 85）
    const contextWindow = Math.ceil(estimated / 0.7);
    const runner = new AgentRunner(sessions, providers, core, events, pricing, undefined, "zh-CN", 50,
      () => ({ contextWindow, capabilities: { modalities: ["text"], thinking: ["disabled"], effort: [] } }) as never,
      undefined, undefined, undefined,
      new Compactor(sessions, makeFakeFastModel("目标：\n- 压缩早期对话\n行动：\n- 强制压缩\n关键发现：\n- 水位达 85%", []), {}, 2));
    runner.setCompactionThreshold(() => 60);
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息，".repeat(30) }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复，".repeat(30) }]);

    await runner.run(session.id, "探针消息".repeat(20));

    // 取压缩前的水位（最后一条 watermark 是压缩重建后的，占用已回落）
    const compactingIndex = published.findIndex((event) => event.type === "context.compacting");
    expect(compactingIndex).toBeGreaterThan(-1);
    const watermark = published.slice(0, compactingIndex).filter((event) => event.type === "context.watermark").at(-1);
    const watermarkPayload = watermark?.payload as { utilization: number; warning?: string };
    // 落在 [0.60, 0.85)：默认 85 水位不会压缩，自定义 60 水位强制压缩
    expect(watermarkPayload.utilization).toBeGreaterThanOrEqual(0.6);
    expect(watermarkPayload.utilization).toBeLessThan(0.85);
    expect(watermarkPayload.warning).toBe("force_compact");
    const compacted = published.filter((event) => event.type === "context.compacted");
    expect(compacted.length).toBeGreaterThan(0);
    expect(compacted.at(-1)?.payload).toMatchObject({ forced: true });
  });
});

describe("isContextOverflowError（F4 溢出判定）", () => {
  it("仅 invalid_request + 已知上下文长度签名判定为溢出", () => {
    const hit = (message: string) => new ProviderError("invalid_request", message, false);
    expect(isContextOverflowError(hit("prompt is too long: 210000 tokens > 200000 maximum"))).toBe(true);
    expect(isContextOverflowError(hit("This model's maximum context length is 8192 tokens"))).toBe(true);
    expect(isContextOverflowError(hit("Error code: 400 - context_length_exceeded"))).toBe(true);
    expect(isContextOverflowError(hit("Request too large: too many tokens in messages"))).toBe(true);
    // 非溢出 400（参数非法等）与可恢复错误绝不误判
    expect(isContextOverflowError(hit("Unknown parameter: foo"))).toBe(false);
    expect(isContextOverflowError(new ProviderError("rate_limit", "prompt is too long", true))).toBe(false);
    expect(isContextOverflowError(new ProviderError("overloaded", "maximum context", true))).toBe(false);
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(false);
    expect(isContextOverflowError("prompt is too long")).toBe(false);
  });
});

describe("水位预算口径与溢出恢复（F2/F3/F4）", () => {
  /** runner 测试装配：fake core + 事件收集 + 可注入窗口/threshold；compactorFor 用同一 SessionStore 造压缩器。 */
  async function makeRunnerFixture(root: string, options: {
    provider: Provider;
    contextWindow: number;
    threshold?: number;
    compactorFor?: (sessions: SessionStore) => Compactor;
  }) {
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register(options.provider);
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const profile = () => ({ contextWindow: options.contextWindow, capabilities: { modalities: ["text"], thinking: ["disabled"], effort: [] } }) as never;
    const runner = new AgentRunner(sessions, providers, core, events, pricing, undefined, "zh-CN", 50, profile, undefined, undefined, undefined, options.compactorFor?.(sessions));
    if (options.threshold !== undefined) runner.setCompactionThreshold(() => options.threshold!);
    return { sessions, runner, published };
  }

  const okProvider = (requests?: StreamChatRequest[]): Provider => ({
    name: "anthropic",
    async *streamChat(request) {
      requests?.push(request);
      yield { type: "done", stopReason: "end_turn" };
    },
  });

  /** 前 failures 次调用抛上下文溢出（invalid_request + 已知签名），之后正常结束。 */
  function overflowProvider(failures: number, requests: StreamChatRequest[]): { provider: Provider; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      provider: {
        name: "anthropic",
        async *streamChat(request: StreamChatRequest) {
          calls += 1;
          requests.push(request);
          if (calls <= failures) {
            throw new ProviderError("invalid_request", "prompt is too long: 210000 tokens > 200000 maximum context length", false);
          }
          yield { type: "done", stopReason: "end_turn" };
        },
      },
    };
  }

  const OVERVIEW_SUMMARY = "目标：\n- 溢出恢复\n行动：\n- 安全压缩\n关键发现：\n- 恢复成功";

  it("F3：工作预算扣除系统段与输出预留——旧口径（全窗口）不触发、新口径触发强制压缩", async () => {
    const root = await tempRoot("owc-compact-budget-");
    const requests: StreamChatRequest[] = [];
    // 与 run 内视图同一估算器：三条消息（两条历史 + 触发消息）的确定 token 估算
    const triggerText = "新的问题，".repeat(30);
    const estimated = estimateMessageTokens([
      { id: "m1", role: "user", content: [{ type: "text", text: "很早的消息，".repeat(30) }], createdAt: new Date(0).toISOString() },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "很早的回复，".repeat(30) }], createdAt: new Date(0).toISOString() },
      { id: "m3", role: "user", content: [{ type: "text", text: triggerText }], createdAt: new Date(0).toISOString() },
    ]);
    // 旧口径 utilization = estimated/window ≈ 0.80 < 0.85 不触发；新口径扣除 1/8 输出预留后 ≈ 0.91 ≥ 0.85
    const contextWindow = Math.ceil(estimated / 0.8);
    expect(estimated / contextWindow).toBeLessThan(0.85);
    const { sessions, runner, published } = await makeRunnerFixture(root, {
      provider: okProvider(requests),
      contextWindow,
      threshold: 85,
      compactorFor: (sessions) => new Compactor(sessions, makeFakeFastModel(OVERVIEW_SUMMARY, []), {}, 2),
    });
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息，".repeat(30) }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复，".repeat(30) }]);

    await runner.run(session.id, triggerText);

    const compactingIndex = published.findIndex((event) => event.type === "context.compacting");
    expect(compactingIndex).toBeGreaterThan(-1);
    const watermark = published.slice(0, compactingIndex).find((event) => event.type === "context.watermark");
    const payload = watermark?.payload as { estimatedTokens: number; contextWindow: number; workingBudget: number; utilization: number; warning?: string };
    expect(payload.estimatedTokens).toBe(estimated);
    expect(payload.contextWindow).toBe(contextWindow);
    // workingBudget = 窗口 − 系统段（repoMap 未启用 = 0）− 输出预留（窗口 1/8）
    expect(payload.workingBudget).toBe(Math.max(1, contextWindow - Math.floor(contextWindow / 8)));
    expect(payload.utilization).toBeGreaterThanOrEqual(0.85);
    expect(payload.warning).toBe("force_compact");
  });

  it("F2：水位强制压缩向 Compactor 下传本轮触发消息保护（protectFromMessageId）", async () => {
    const root = await tempRoot("owc-compact-protect-run-");
    const compactCalls: Array<{ forced?: boolean; protectFromMessageId?: string }> = [];
    const { sessions, runner } = await makeRunnerFixture(root, {
      provider: okProvider(),
      contextWindow: 100,
      compactorFor: () => ({
        async compact(_sessionId: string, _mode: string, options?: { forced?: boolean; protectFromMessageId?: string }) {
          compactCalls.push(options ?? {});
          return { changed: false, mode: "overview" };
        },
      }) as unknown as Compactor,
    });
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息，".repeat(30) }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复，".repeat(30) }]);

    await runner.run(session.id, "触发消息正文");

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toMatchObject({ forced: true });
    const detail = (await sessions.get(session.id))!;
    const trigger = detail.messages.find((message) => message.role === "user" && message.content.some((block) => block.type === "text" && block.text === "触发消息正文"));
    expect(compactCalls[0]!.protectFromMessageId).toBe(trigger?.id);
  });

  it("F4：Provider 溢出 → 一次性安全压缩恢复（reason=overflow_recovery）→ 重试成功", async () => {
    const root = await tempRoot("owc-compact-overflow-");
    const requests: StreamChatRequest[] = [];
    const { provider, calls } = overflowProvider(1, requests);
    // 窗口极大：水位压缩不参与，唯一压缩来自溢出恢复
    const { sessions, runner, published } = await makeRunnerFixture(root, {
      provider,
      contextWindow: 1_000_000,
      compactorFor: (sessions) => new Compactor(sessions, makeFakeFastModel(OVERVIEW_SUMMARY, []), {}, 2),
    });
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息" }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复" }]);

    await runner.run(session.id, "触发消息");

    // 溢出后压缩一次并重试：provider 恰好调用两次
    expect(calls()).toBe(2);
    const compacting = published.filter((event) => event.type === "context.compacting");
    expect(compacting).toHaveLength(1);
    expect(compacting[0]?.payload).toMatchObject({ forced: true, mode: "overview", reason: "overflow_recovery" });
    expect(published.filter((event) => event.type === "context.compacted")[0]?.payload).toMatchObject({ forced: true, reason: "overflow_recovery" });
    // 压缩账本落盘，重试时 provider 收到压缩后的视图（首条为摘要头）
    const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
    expect(ledger.compacted?.summary).toContain("溢出恢复");
    expect(requests.at(-1)?.messages[0]?.id).toMatch(/^compaction:/);
  });

  it("F4：恢复后再次溢出 → 干净失败（不无限循环，原错误抛出）", async () => {
    const root = await tempRoot("owc-compact-overflow2-");
    const requests: StreamChatRequest[] = [];
    const { provider, calls } = overflowProvider(Number.MAX_SAFE_INTEGER, requests);
    const { sessions, runner, published } = await makeRunnerFixture(root, {
      provider,
      contextWindow: 1_000_000,
      compactorFor: (sessions) => new Compactor(sessions, makeFakeFastModel(OVERVIEW_SUMMARY, []), {}, 2),
    });
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息" }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复" }]);

    await expect(runner.run(session.id, "触发消息")).rejects.toThrow(/prompt is too long/);
    // 一次性：压缩恢复只发生一次，第二次溢出直接失败
    expect(calls()).toBe(2);
    expect(published.filter((event) => event.type === "context.compacting")).toHaveLength(1);
    expect(published.find((event) => event.type === "agent.error")?.payload).toMatchObject({ retryable: false, kind: "invalid_request" });
  });

  it("F4：溢出但压缩无可裁区段 → 可行动错误（提示 /clear 或新会话）", async () => {
    const root = await tempRoot("owc-compact-overflow3-");
    const requests: StreamChatRequest[] = [];
    const { provider, calls } = overflowProvider(Number.MAX_SAFE_INTEGER, requests);
    const { sessions, runner, published } = await makeRunnerFixture(root, {
      provider,
      contextWindow: 1_000_000,
      // keepTail=2 而活动路径只有触发消息一条：区段为空 → changed:false
      compactorFor: (sessions) => new Compactor(sessions, makeFakeFastModel(OVERVIEW_SUMMARY, []), {}, 2),
    });
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });

    await expect(runner.run(session.id, "触发消息")).rejects.toThrow(/无可裁减区段/);
    expect(calls()).toBe(1);
    const errorEvent = published.find((event) => event.type === "agent.error");
    expect(String((errorEvent?.payload as { message: string }).message)).toContain("/clear");
  });

  it("F4：threshold=100 关闭水位强制压缩（无 force_compact 警告），溢出恢复仍可用", async () => {
    const root = await tempRoot("owc-compact-threshold100-");
    const requests: StreamChatRequest[] = [];
    // 窗口极小（利用率远超 100%）：threshold=100 时水位压缩不得触发
    const { sessions, runner, published } = await makeRunnerFixture(root, {
      provider: okProvider(requests),
      contextWindow: 100,
      threshold: 100,
      compactorFor: (sessions) => new Compactor(sessions, makeFakeFastModel(OVERVIEW_SUMMARY, []), {}, 2),
    });
    const session = await sessions.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息，".repeat(30) }]);
    await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复，".repeat(30) }]);

    await runner.run(session.id, "新的问题，".repeat(30));

    // 阈值型强制压缩关闭：无压缩事件；水位警告最高只到 compact_recommended（不谎称会强制）
    expect(published.filter((event) => event.type === "context.compacting")).toHaveLength(0);
    const watermark = published.find((event) => event.type === "context.watermark");
    expect((watermark?.payload as { warning?: string }).warning).toBe("compact_recommended");
    expect(requests.length).toBeGreaterThan(0);

    // 同 threshold=100：溢出恢复不受影响（明确标记的安全压缩仍触发一次）
    const requests2: StreamChatRequest[] = [];
    const { provider, calls } = overflowProvider(1, requests2);
    const { sessions: sessions2, runner: runner2, published: published2 } = await makeRunnerFixture(root, {
      provider,
      contextWindow: 1_000_000,
      threshold: 100,
      compactorFor: (store) => new Compactor(store, makeFakeFastModel("目标：\n- 溢出恢复\n行动：\n- 安全压缩\n关键发现：\n- 阈值 100 下仍恢复", []), {}, 2),
    });
    const session2 = await sessions2.create({ cwd: root, provider: "anthropic", model: "tiny" });
    await sessions2.appendMessage(session2.id, "user", [{ type: "text", text: "很早的消息" }]);
    await sessions2.appendMessage(session2.id, "assistant", [{ type: "text", text: "很早的回复" }]);

    await runner2.run(session2.id, "触发消息");

    expect(calls()).toBe(2);
    expect(published2.filter((event) => event.type === "context.compacting")[0]?.payload).toMatchObject({ forced: true, reason: "overflow_recovery" });
  });
});

describe("compact HTTP routes", () => {
  it("serves POST /compact and the /compact composer command", async () => {
    const root = await tempRoot("owc-compact-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    const core = { on() { return core; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const compactor = new Compactor(sessions, EMPTY_FAST_MODEL, {}, 3);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, compactor });
    try {
      const session = await sessions.create({ cwd: os.tmpdir(), title: "HTTP 压缩" });
      for (let index = 0; index < 5; index += 1) {
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: `消息 ${index + 1}` }]);
      }

      const rest = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/compact`, payload: { mode: "toolcalls" } });
      expect(rest.statusCode).toBe(200);
      expect(rest.json<{ changed: boolean; uptoIndex?: number }>()).toMatchObject({ changed: true, uptoIndex: 2 });

      for (let index = 0; index < 4; index += 1) {
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: `再来 ${index + 1}` }]);
      }
      const slash = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/compact tools" } });
      expect(slash.statusCode).toBe(200);
      expect(slash.json<{ compacted: boolean }>().compacted).toBe(true);

      // 再补 4 条制造可压缩区段，未配置快速模型的 overview 应 400
      for (let index = 0; index < 4; index += 1) {
        await sessions.appendMessage(session.id, "user", [{ type: "text", text: `还有 ${index + 1}` }]);
      }
      const overview = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/compact" } });
      expect(overview.statusCode).toBe(400);
      expect(overview.json<{ error: string }>().error).toContain("快速模型未配置");

      // 三个手动触发（REST + 两次斜杠）都在压缩开始时发布 compacting 事件（失败那次同样有开始反馈）
      const compactingEvents = published.filter((event) => event.type === "context.compacting");
      expect(compactingEvents).toHaveLength(3);
      expect(compactingEvents[0]?.payload).toMatchObject({ forced: false, mode: "toolcalls" });
      expect(compactingEvents[2]?.payload).toMatchObject({ forced: false, mode: "overview" });
    } finally {
      await app.close();
    }
  });
});

describe("compactionHistory", () => {
  it("每次压缩追加历史并烧入 replacedTokens，compacted 与历史末条一致且带回 createdAt", async () => {
    const root = await tempRoot("owc-compact-hist-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 6);
    const compactor = new Compactor(store, makeFakeFastModel("目标：\n- 摘要\n行动：\n- 压缩前缀\n修改文件：\n- 无"), {}, 2);

    const first = await compactor.compact(id, "overview");
    expect(first.createdAt).toEqual(expect.any(String));
    await store.appendMessage(id, "user", [{ type: "text", text: "补充 1" }]);
    await store.appendMessage(id, "assistant", [{ type: "text", text: "补充 2" }]);
    const second = await compactor.compact(id, "overview");

    const ledger = await new ContextManager(store.contextRoot(id)).load();
    expect(ledger.compactionHistory).toHaveLength(2);
    expect(ledger.compacted).toEqual(ledger.compactionHistory![1]);
    expect(ledger.compactionHistory![0]!.uptoIndex).toBeLessThan(ledger.compactionHistory![1]!.uptoIndex);
    for (const record of ledger.compactionHistory!) {
      expect(record.replacedTokens).toEqual(expect.any(Number));
      expect(record.replacedTokens).toBeGreaterThan(0);
    }
    expect(second.createdAt).toBe(ledger.compacted!.createdAt);
  });

  it("历史封顶 20 条，超出丢最旧", async () => {
    const root = await tempRoot("owc-compact-cap-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const id = await sessionWithMessages(store, 2);
    const compactor = new Compactor(store, makeFakeFastModel("目标：\n- 摘要\n行动：\n- 压缩前缀\n修改文件：\n- 无"), {}, 1);
    const firstUptos: number[] = [];
    for (let round = 0; round < 21; round += 1) {
      const result = await compactor.compact(id, "overview");
      expect(result.changed).toBe(true);
      firstUptos.push(result.uptoIndex!);
      await store.appendMessage(id, "user", [{ type: "text", text: `轮 ${round}` }]);
    }
    const ledger = await new ContextManager(store.contextRoot(id)).load();
    expect(ledger.compactionHistory).toHaveLength(20);
    // 最旧一条（uptoIndex=firstUptos[0]）被丢弃，现存最早为第二次压缩
    expect(ledger.compactionHistory![0]!.uptoIndex).toBe(firstUptos[1]);
    expect(ledger.compacted!.uptoIndex).toBe(firstUptos[20]);
  });

  it("旧账本无历史字段无损读取；replaceLedger 清洗非法条目并封顶", async () => {
    const root = await tempRoot("owc-compact-norm-");
    const manager = new ContextManager(path.join(root, "ctx"));
    const legacy = await manager.load();
    expect(legacy.compactionHistory).toBeUndefined();

    const valid = { uptoIndex: 1, mode: "overview", summary: "s", instructions: ["a", 1], createdAt: new Date().toISOString() };
    const entries = [
      ...Array.from({ length: 21 }, (_, index) => ({ ...valid, uptoIndex: index + 1 })),
      { uptoIndex: -1, mode: "overview", summary: "bad", instructions: [], createdAt: "x" },
      "not-a-record",
    ];
    const ledger = await manager.replaceLedger({ round: 1, compactionHistory: entries });
    expect(ledger.compactionHistory).toHaveLength(20);
    expect(ledger.compactionHistory![0]!.uptoIndex).toBe(2);
    expect(ledger.compactionHistory!.every((record) => record.instructions.every((item) => typeof item === "string"))).toBe(true);

    // 落盘后再加载同样干净（normalizeLedger 路径）
    const reloaded = await manager.load();
    expect(reloaded.compactionHistory).toHaveLength(20);
    expect(reloaded.compactionHistory![19]!.instructions).toEqual(["a"]);
  });
});
