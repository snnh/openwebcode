// 扩展示例：演示 1.1.0 起对第三方开放的扩展 API。
// activate(ctx) 由 Extension Host 调用；ctx 上的能力逐项按 manifest 权限校验。

export function activate(ctx) {
  // ---- 私有存储（无需权限）：<dataDir>/extensions-data/demo/ 下的相对路径 ----
  const NOTES_FILE = "notes.json";

  async function readNotes() {
    const { content } = await ctx.storage.read(NOTES_FILE);
    return content ? JSON.parse(content) : [];
  }

  async function writeNotes(notes) {
    await ctx.storage.write(NOTES_FILE, JSON.stringify(notes, null, 2));
  }

  // ---- 私有 HTTP 路由（权限 http:route）：挂载在 /api/ext/demo/notes ----
  // handler 收 { method, path, query, body }，返回 { status, body } 原样响应。
  ctx.registerRoute("GET", "/notes", async () => {
    return { status: 200, body: { notes: await readNotes() } };
  });

  ctx.registerRoute("POST", "/notes", async (request) => {
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!text) return { status: 400, body: { error: "text is required" } };
    const notes = await readNotes();
    notes.push({ text, createdAt: new Date().toISOString() });
    await writeNotes(notes);
    return { status: 201, body: { count: notes.length } };
  });

  ctx.registerRoute("DELETE", "/notes", async () => {
    await ctx.storage.delete(NOTES_FILE);
    return { status: 200, body: { cleared: true } };
  });

  // ---- 快速模型通道（权限 model:fast）：prompt ≤32 KiB、maxTokens ≤4096 ----
  // 同时注册一个 agent 工具（权限 tools:register），模型可在会话里调用 ext__demo__summarize。
  ctx.registerTool(
    { name: "summarize", description: "Summarize text with the fast model", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    async (input) => {
      const result = await ctx.model.complete({ prompt: `用三句话总结以下内容：\n${String(input.text ?? "")}`, maxTokens: 256 });
      return result.text;
    },
  );

  // ---- 会话上下文（权限 context:read）：读取会话 compact/ 归档目录（档案库压缩产出）----
  // readVaultFile(sessionId, relativePath) 只读、路径锁定在 <会话目录>/compact/ 内；
  // 无归档或路径非法时返回 { content: null } 或拒绝。同样需要 tools:register 才能暴露为工具。
  ctx.registerTool(
    { name: "vault_peek", description: "Read a file from the session compact archive (compact-vault extension output)", inputSchema: { type: "object", properties: { sessionId: { type: "string" }, path: { type: "string" } }, required: ["sessionId", "path"] } },
    async (input) => {
      const result = await ctx.context.readVaultFile(String(input.sessionId), String(input.path));
      return result.content ?? "(no archive or file missing)";
    },
  );

  // ---- 提示词钩子（权限 prompt:shape）：给系统提示词追加一段产品段落 ----
  // 载荷含 extensionState（会话级扩展状态），可读取 PUT /api/sessions/:id/config 写入的会话级配置。
  ctx.on("prompt.beforeBuild", (payload) => {
    const tagline = payload.extensionState?.demo?.tagline;
    if (typeof tagline !== "string" || !tagline) return {};
    return { prependSections: [`## Demo extension\n${tagline}`] };
  });
}
