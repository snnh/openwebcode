import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { isLoopbackOrLAN } from "../src/auth-totp.js";
import type { ChatAssistantStore, ChatConfigService, ChatRunner } from "../src/chat/index.js";
import { ChatSessionStore } from "../src/chat/chat-session-store.js";
import type { ChatAssistant, ChatConfig } from "../src/chat/index.js";
import type { CoreClient } from "../src/core-client.js";
import type { ModelRegistry } from "../src/context/model-registry.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

type ChatRunParams = Parameters<ChatRunner["runChatMessage"]>[0];

const ACCESS_TOKEN = "test-access-token-0123456789abcdef";

interface Rig {
  app: FastifyInstance;
  chatSessions: ChatSessionStore;
  runnerCalls: ChatRunParams[];
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** 标准 rig：临时目录 + 真 ChatSessionStore + 捕获参数的假 ChatRunner + 可配 chatConfig/assistants/auth */
async function setup(options: { auth?: boolean; chatConfig?: ChatConfig; assistants?: ChatAssistant[]; models?: ModelRegistry; providerNames?: string[] } = {}): Promise<Rig> {
  const root = await tempRoot("owc-chat-routes-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const chatSessions = new ChatSessionStore(root);
  await chatSessions.initialize();
  const runnerCalls: ChatRunParams[] = [];
  const chatRunner = {
    isRunning: () => false,
    stopChatMessage: () => undefined,
    runChatMessage: (params: ChatRunParams) => {
      runnerCalls.push(params);
      return Promise.resolve({ assistantContent: [], stopReason: "end_turn" });
    },
  } as unknown as ChatRunner;
  const chatConfig = {
    get: () => Promise.resolve(options.chatConfig ?? {}),
    save: () => Promise.resolve(),
  } as ChatConfigService;
  const chatAssistants = {
    get: (id: string) => Promise.resolve((options.assistants ?? []).find((assistant) => assistant.id === id)),
  } as unknown as ChatAssistantStore;
  const providers = new ProviderRegistry();
  for (const name of options.providerNames ?? []) {
    providers.register({ name, streamChat: () => (async function* () { /* stub */ })() });
  }
  const app = await buildServer({
    core: {} as CoreClient,
    sessions,
    agent: { isRunning: () => false } as unknown as AgentRunner,
    events: new EventBus(),
    providers,
    pricing,
    chatSessions,
    chatRunner,
    chatConfig,
    chatAssistants,
    dataDir: root,
    ...(options.models ? { models: options.models } : {}),
    ...(options.auth ? { auth: { accessToken: ACCESS_TOKEN, allowedOrigins: [] as string[] } } : {}),
  });
  apps.push(app);
  return { app, chatSessions, runnerCalls };
}

async function createSession(app: FastifyInstance, body: Record<string, unknown> = { provider: "p", model: "m" }): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/chat/sessions", payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

describe("POST /api/chat/sessions/:id/messages 父链", () => {
  it("多轮发送时 runner 收到的 meta.activeLeafId 是当轮新用户消息", async () => {
    const { app, chatSessions, runnerCalls } = await setup();
    const id = await createSession(app);

    const first = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/messages`, payload: { text: "first" } });
    expect(first.statusCode, first.body).toBe(202);
    const second = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/messages`, payload: { text: "second" } });
    expect(second.statusCode, second.body).toBe(202);

    const messages = await chatSessions.getMessages(id);
    expect(messages).toHaveLength(2);
    // 父链：第二条用户消息的 parentId 是第一条
    expect(messages[1]!.parentId).toBe(messages[0]!.id);
    // 两次 runner 调用拿到的 meta.activeLeafId 都是当轮新用户消息（非陈旧 meta）
    expect(runnerCalls).toHaveLength(2);
    expect(runnerCalls[0]!.meta.activeLeafId).toBe(messages[0]!.id);
    expect(runnerCalls[1]!.meta.activeLeafId).toBe(messages[1]!.id);
  });
});

describe("POST /api/chat/sessions 默认配置消费", () => {
  const assistant: ChatAssistant = {
    id: "a1",
    name: "预设助手",
    systemPrompt: "助手提示词",
    provider: "pa",
    model: "ma",
    temperature: 0.5,
    toolList: ["python"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("body 未指定时按 助手 > 全局默认 应用", async () => {
    const { app } = await setup({
      chatConfig: { defaultProvider: "p0", defaultModel: "m0", defaultAssistantId: "a1" },
      assistants: [assistant],
    });
    const res = await app.inject({ method: "POST", url: "/api/chat/sessions", payload: {} });
    expect(res.statusCode, res.body).toBe(201);
    const meta = res.json();
    expect(meta.provider).toBe("pa");
    expect(meta.model).toBe("ma");
    expect(meta.systemPrompt).toBe("助手提示词");
    expect(meta.enabledTools).toEqual(["python"]);
    expect(meta.temperature).toBe(0.5);
    expect(meta.assistantId).toBe("a1");
  });

  it("body 显式值优先于助手与全局默认；无默认且未指定时 400", async () => {
    const { app } = await setup({
      chatConfig: { defaultProvider: "p0", defaultModel: "m0", defaultAssistantId: "a1" },
      assistants: [assistant],
    });
    const res = await app.inject({ method: "POST", url: "/api/chat/sessions", payload: { provider: "pb", model: "mb" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().provider).toBe("pb");
    expect(res.json().model).toBe("mb");

    const bare = await setup();
    const missing = await bare.app.inject({ method: "POST", url: "/api/chat/sessions", payload: {} });
    expect(missing.statusCode).toBe(400);
  });
});

describe("PATCH /api/chat/sessions/:id 鉴权与校验", () => {
  it("仅 title 免凭据；带配置字段 401；带 bearer 放行", async () => {
    const { app } = await setup({ auth: true });
    const id = await createSession(app);

    const titleOnly = await app.inject({ method: "PATCH", url: `/api/chat/sessions/${id}`, payload: { title: "新标题" } });
    expect(titleOnly.statusCode, titleOnly.body).toBe(200);
    expect(titleOnly.json().title).toBe("新标题");

    const configPatch = await app.inject({ method: "PATCH", url: `/api/chat/sessions/${id}`, payload: { model: "m2" } });
    expect(configPatch.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "PATCH",
      url: `/api/chat/sessions/${id}`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: { model: "m2" },
    });
    expect(authorized.statusCode, authorized.body).toBe(200);
    expect(authorized.json().model).toBe("m2");
  });

  it("非法字段值 400", async () => {
    const { app } = await setup({ auth: true });
    const id = await createSession(app);
    const badTitle = await app.inject({ method: "PATCH", url: `/api/chat/sessions/${id}`, payload: { title: 123 } });
    expect(badTitle.statusCode).toBe(400);
    const badTools = await app.inject({
      method: "PATCH",
      url: `/api/chat/sessions/${id}`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: { enabledTools: "python" },
    });
    expect(badTools.statusCode).toBe(400);
    const badSandbox = await app.inject({
      method: "PATCH",
      url: `/api/chat/sessions/${id}`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: { sandboxEnabled: "yes" },
    });
    expect(badSandbox.statusCode).toBe(400);
  });
});

describe("chat.json lanUnauthenticated", () => {
  it("置 false 时 LAN 不再免凭据；缺省 true 放行", async () => {
    const strictRig = await setup({ auth: true, chatConfig: { lanUnauthenticated: false } });
    const denied = await strictRig.app.inject({ method: "GET", url: "/api/chat/sessions" });
    expect(denied.statusCode).toBe(401);
    const authorized = await strictRig.app.inject({
      method: "GET",
      url: "/api/chat/sessions",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(authorized.statusCode).toBe(200);

    const defaultRig = await setup({ auth: true });
    const allowed = await defaultRig.app.inject({ method: "GET", url: "/api/chat/sessions" });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("share.passwordHash 出站脱敏", () => {
  it("list/get/share/export 响应均不含 passwordHash", async () => {
    const { app } = await setup();
    const id = await createSession(app);
    const share = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/share`, payload: { password: "pw" } });
    expect(share.statusCode, share.body).toBe(201);
    expect(share.json().passwordHash).toBeUndefined();
    expect(share.json().hasPassword).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/chat/sessions" });
    expect(list.body).not.toContain("passwordHash");
    expect(list.json()[0].share.hasPassword).toBe(true);

    const detail = await app.inject({ method: "GET", url: `/api/chat/sessions/${id}` });
    expect(detail.body).not.toContain("passwordHash");

    const exported = await app.inject({ method: "GET", url: `/api/chat/sessions/${id}/export?format=json` });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain("passwordHash");
  });
});

describe("分享 slug ASCII 化", () => {
  it("中文标题折叠为 [a-z0-9-]，无有效字符回退 chat", async () => {
    const { app } = await setup();
    const id = await createSession(app, { provider: "p", model: "m", title: "你好世界 Hello--World" });
    const share = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/share`, payload: {} });
    expect(share.statusCode, share.body).toBe(201);
    const slug = share.json().slug as string;
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).toBe("hello-world");

    const symbolsOnly = await createSession(app, { provider: "p", model: "m", title: "！！！" });
    const fallback = await app.inject({ method: "POST", url: `/api/chat/sessions/${symbolsOnly}/share`, payload: {} });
    expect(fallback.json().slug).toBe("chat");
  });
});

describe("POST /api/share/:shareId/verify", () => {
  async function shareWithPassword(app: FastifyInstance): Promise<string> {
    const id = await createSession(app);
    const share = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/share`, payload: { password: "pw" } });
    return share.json().id as string;
  }

  it("连续 5 次失败锁 60 秒（429），锁定期间正确口令同样被拒", async () => {
    const { app } = await setup();
    const shareId = await shareWithPassword(app);
    for (let index = 0; index < 5; index += 1) {
      const res = await app.inject({ method: "POST", url: `/api/share/${shareId}/verify`, payload: { password: "wrong" } });
      expect(res.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: "POST", url: `/api/share/${shareId}/verify`, payload: { password: "wrong" } });
    expect(locked.statusCode).toBe(429);
    const lockedEvenIfCorrect = await app.inject({ method: "POST", url: `/api/share/${shareId}/verify`, payload: { password: "pw" } });
    expect(lockedEvenIfCorrect.statusCode).toBe(429);
  });

  it("token 为 HMAC：verify 颁发，旧 SHA256(shareId:passwordHash) 伪造不再通过", async () => {
    const { app, chatSessions } = await setup();
    const shareId = await shareWithPassword(app);
    const verify = await app.inject({ method: "POST", url: `/api/share/${shareId}/verify`, payload: { password: "pw" } });
    expect(verify.statusCode, verify.body).toBe(200);
    const token = verify.json().token as string;
    expect(typeof token).toBe("string");

    const ok = await app.inject({ method: "GET", url: `/api/share/${shareId}/messages?token=${token}` });
    expect(ok.statusCode, ok.body).toBe(200);

    // 旧算法 SHA256(shareId:passwordHash) 可脱机伪造；现应 401
    const session = (await chatSessions.list()).find((entry) => entry.share?.id === shareId)!;
    const forged = createHash("sha256").update(`${shareId}:${session.share!.passwordHash}`).digest("hex");
    const forgedRes = await app.inject({ method: "GET", url: `/api/share/${shareId}/messages?token=${forged}` });
    expect(forgedRes.statusCode).toBe(401);
    expect(forged).not.toBe(token);
  });
});

describe("POST /api/chat/sessions/:id/messages/:messageId/retry", () => {
  it("非 assistant 消息 400；正常重生成 202 且 runner 拿到 checkout 后的 meta", async () => {
    const { app, chatSessions, runnerCalls } = await setup();
    const id = await createSession(app);
    const userMsg = await chatSessions.appendMessage(id, "user", [{ type: "text", text: "原始问题" }]);
    const assistantMsg = await chatSessions.appendMessage(id, "assistant", [{ type: "text", text: "旧回答" }]);

    const badRole = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/messages/${userMsg.id}/retry` });
    expect(badRole.statusCode).toBe(400);

    const missing = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/messages/does-not-exist/retry` });
    expect(missing.statusCode).toBe(404);

    const ok = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/messages/${assistantMsg.id}/retry` });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(typeof ok.json().runId).toBe("string");
    // checkout 到产生该 assistant 消息的 user 消息；runner 收到的 meta.activeLeafId 与其一致
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.meta.activeLeafId).toBe(userMsg.id);
    expect(runnerCalls[0]!.userMessage).toBe("原始问题");
    const meta = await chatSessions.get(id);
    expect(meta?.activeLeafId).toBe(userMsg.id);
  });
});

describe("checkout 校验", () => {
  it("messageId 不存在时路由 404", async () => {
    const { app } = await setup();
    const id = await createSession(app);
    const res = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/checkout`, payload: { messageId: "does-not-exist" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("isLoopbackOrLAN IPv4-mapped IPv6", () => {
  it("::ffff: 前缀剥离后走 IPv4 判定", () => {
    expect(isLoopbackOrLAN("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackOrLAN("::ffff:192.168.1.5")).toBe(true);
    expect(isLoopbackOrLAN("::ffff:10.0.0.8")).toBe(true);
    expect(isLoopbackOrLAN("::ffff:8.8.8.8")).toBe(false);
  });
});

const PNG_B64 = Buffer.from([137, 80, 78, 71]).toString("base64");

describe("POST /api/chat/sessions/:id/uploads", () => {
  it("成功落盘并返回 ref；GET images 按 ref 回读（Content-Type 正确）", async () => {
    const { app } = await setup();
    const id = await createSession(app);
    const res = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/uploads`, payload: { data: PNG_B64, mediaType: "image/png" } });
    expect(res.statusCode, res.body).toBe(201);
    const ref = res.json().ref as string;
    expect(ref).toMatch(/^uploads\/[0-9a-f-]+\.png$/);

    const got = await app.inject({ method: "GET", url: `/api/chat/sessions/${id}/images/${ref}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.rawPayload.equals(Buffer.from([137, 80, 78, 71]))).toBe(true);
  });

  it("非图片 mediaType 400；超过 10MB 413", async () => {
    const { app } = await setup();
    const id = await createSession(app);
    const bad = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/uploads`, payload: { data: PNG_B64, mediaType: "text/plain" } });
    expect(bad.statusCode).toBe(400);
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    const tooBig = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/uploads`, payload: { data: oversized, mediaType: "image/png" } });
    expect(tooBig.statusCode, tooBig.body.slice(0, 200)).toBe(413);
  });

  it("路径遍历与白名单外前缀 400；缺失文件 404", async () => {
    const { app } = await setup();
    const id = await createSession(app);
    const traversal = await app.inject({ method: "GET", url: `/api/chat/sessions/${id}/images/..%2Fmeta.json` });
    expect(traversal.statusCode).toBe(400);
    const outsidePrefix = await app.inject({ method: "GET", url: `/api/chat/sessions/${id}/images/meta.json` });
    expect(outsidePrefix.statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: `/api/chat/sessions/${id}/images/uploads/nope.png` });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/chat/sessions/:id/messages 图片块", () => {
  it("content 数组：base64 内嵌成功，落盘消息含 image 块", async () => {
    const { app, chatSessions, runnerCalls } = await setup();
    const id = await createSession(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${id}/messages`,
      payload: { content: [{ type: "text", text: "看图" }, { type: "image", data: PNG_B64, mediaType: "image/png" }] },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.userMessage).toBe("看图");
    expect(runnerCalls[0]!.images).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
    const messages = await chatSessions.getMessages(id);
    const imageBlock = messages[0]!.content.find((block) => block.type === "image");
    expect(imageBlock).toMatchObject({ type: "image", data: PNG_B64, mediaType: "image/png" });
  });

  it("旧形态 { text, images } 保持兼容", async () => {
    const { app, runnerCalls } = await setup();
    const id = await createSession(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${id}/messages`,
      payload: { text: "旧形态", images: [{ data: PNG_B64, mediaType: "image/png" }] },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(runnerCalls[0]!.images).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
  });

  it("base64 超过 2MB 拒绝（提示走 uploads）", async () => {
    const { app } = await setup();
    const id = await createSession(app);
    const big = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${id}/messages`,
      payload: { content: [{ type: "text", text: "x" }, { type: "image", data: big, mediaType: "image/png" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("uploads");
  });

  it("ref 不存在 400；ref 存在时落盘 ref 块（无内联 data）", async () => {
    const { app, chatSessions, runnerCalls } = await setup();
    const id = await createSession(app);
    const missing = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${id}/messages`,
      payload: { content: [{ type: "text", text: "x" }, { type: "image", ref: "uploads/ghost.png", mediaType: "image/png" }] },
    });
    expect(missing.statusCode).toBe(400);

    const upload = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/uploads`, payload: { data: PNG_B64, mediaType: "image/png" } });
    const ref = upload.json().ref as string;
    const ok = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${id}/messages`,
      payload: { content: [{ type: "text", text: "ref 图" }, { type: "image", ref, mediaType: "image/png" }] },
    });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(runnerCalls[0]!.images).toEqual([{ mediaType: "image/png", ref }]);
    const messages = await chatSessions.getMessages(id);
    const imageBlock = messages[0]!.content.find((block) => block.type === "image");
    expect(imageBlock).toMatchObject({ type: "image", ref, mediaType: "image/png" });
    expect(imageBlock && "data" in imageBlock ? imageBlock.data : undefined).toBeUndefined();
  });

  it("单消息超过 3 张图 400", async () => {
    const { app } = await setup();
    const id = await createSession(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/sessions/${id}/messages`,
      payload: {
        content: [
          { type: "text", text: "x" },
          ...Array.from({ length: 4 }, () => ({ type: "image", data: PNG_B64, mediaType: "image/png" })),
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("3");
  });
});

describe("GET /api/chat/models 能力声明", () => {
  it("每个模型附 modalities 与 imageOutput", async () => {
    const models = {
      list: () => [
        {
          id: "m-vision",
          provider: "p1",
          contextWindow: 128000,
          source: "builtin",
          capabilities: { modalities: ["text", "image"], imageOutput: false, thinking: ["adaptive"], effort: [], tools: true },
        },
        {
          id: "m-imagegen",
          provider: "p1",
          contextWindow: 128000,
          source: "builtin",
          capabilities: { modalities: ["text"], imageOutput: true, thinking: ["adaptive"], effort: [], tools: true },
        },
        {
          id: "m-other",
          provider: "p2",
          contextWindow: 128000,
          source: "builtin",
          capabilities: { modalities: ["text"], imageOutput: false, thinking: ["adaptive"], effort: [], tools: true },
        },
      ],
    } as unknown as ModelRegistry;
    const { app } = await setup({ models, providerNames: ["p1"] });
    const res = await app.inject({ method: "GET", url: "/api/chat/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{
      provider: "p1",
      models: [
        { id: "m-vision", modalities: ["text", "image"], imageOutput: false },
        { id: "m-imagegen", modalities: ["text"], imageOutput: true },
      ],
    }]);
  });
});

describe("GET /api/share/:shareId/images/*", () => {
  it("无口令分享直接回图；有口令需 verify 颁发的 token", async () => {
    const { app } = await setup();
    const id = await createSession(app);
    const upload = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/uploads`, payload: { data: PNG_B64, mediaType: "image/png" } });
    const ref = upload.json().ref as string;

    const share = await app.inject({ method: "POST", url: `/api/chat/sessions/${id}/share`, payload: {} });
    const shareId = share.json().id as string;
    const open = await app.inject({ method: "GET", url: `/api/share/${shareId}/images/${ref}` });
    expect(open.statusCode).toBe(200);
    expect(open.headers["content-type"]).toBe("image/png");

    // 加口令的分享：无 token 401，token 错误 401，verify 后 200
    const id2 = await createSession(app);
    const upload2 = await app.inject({ method: "POST", url: `/api/chat/sessions/${id2}/uploads`, payload: { data: PNG_B64, mediaType: "image/png" } });
    const ref2 = upload2.json().ref as string;
    const share2 = await app.inject({ method: "POST", url: `/api/chat/sessions/${id2}/share`, payload: { password: "pw" } });
    const shareId2 = share2.json().id as string;
    const denied = await app.inject({ method: "GET", url: `/api/share/${shareId2}/images/${ref2}` });
    expect(denied.statusCode).toBe(401);
    const badToken = await app.inject({ method: "GET", url: `/api/share/${shareId2}/images/${ref2}?token=deadbeef` });
    expect(badToken.statusCode).toBe(401);
    const verify = await app.inject({ method: "POST", url: `/api/share/${shareId2}/verify`, payload: { password: "pw" } });
    const token = verify.json().token as string;
    const allowed = await app.inject({ method: "GET", url: `/api/share/${shareId2}/images/${ref2}?token=${token}` });
    expect(allowed.statusCode).toBe(200);
  });
});
