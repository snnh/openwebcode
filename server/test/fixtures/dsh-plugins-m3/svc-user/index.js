// dsh 兼容层 M3 fixture：服务缝投影——storage 读写、llm.complete、sessions.list、dshEvents 订阅，
// 各能力经 defineTool 暴露供集成测试逐个触发与断言。
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "svc-user";
export const inject = ["tools", "llm", "sessions", "storage", "dshEvents"];

function text(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}

export function apply(ctx) {
  const tools = ctx.get("tools");
  const llm = ctx.get("llm");
  const sessions = ctx.get("sessions");
  const storage = ctx.get("storage");
  const dshEvents = ctx.get("dshEvents");

  // dshEvents 订阅：白名单事件 → 写入 storage（供测试断言事件确实到达插件 ctx）。
  dshEvents.subscribe(["agent.state", "tool.start"], (event) => {
    void storage.write(`events/${event.type}.json`, JSON.stringify({ type: event.type, sessionId: event.sessionId ?? null, payload: event.payload }));
  });

  tools.register(defineTool({
    name: "svc_storage_roundtrip",
    description: "扩展私有存储读写往返",
    parameters: { content: { type: "string", required: true } },
    output: { schema: { type: "json" }, render: (_a, v) => text(v) },
    execute: async (args) => {
      await storage.write("note.txt", args.content);
      const read = await storage.read("note.txt");
      const list = await storage.list();
      return { read: read.content, files: list.files };
    },
  }));

  tools.register(defineTool({
    name: "svc_llm_complete",
    description: "经模型网关快速补全",
    parameters: { prompt: { type: "string", required: true } },
    output: { schema: { type: "json" }, render: (_a, v) => text(v) },
    execute: async (args) => ({ text: (await llm.complete({ prompt: args.prompt })).text }),
  }));

  tools.register(defineTool({
    name: "svc_sessions_list",
    description: "只读会话列表（元信息白名单）",
    parameters: {},
    output: { schema: { type: "json" }, render: (_a, v) => text(v) },
    execute: async () => ({ count: (await sessions.list()).length }),
  }));
}
