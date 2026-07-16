import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./lib/api";
import type { AppEvent, ChatMessage, ModelProfile, Session, SessionDetail } from "./lib/contracts";

const queryKeys = { sessions: ["sessions"] as const, detail: (id: string) => ["session", id] as const };

function formatCurrency(microUnits: string, currency: string): string {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: currency === "CNY" ? "CNY" : "USD" }).format(Number(BigInt(microUnits)) / 1_000_000);
}

export function App(): ReactElement {
  const queryClient = useQueryClient();
  const [currentId, setCurrentId] = useState<string>();
  const [panel, setPanel] = useState<"files" | "context" | "timeline" | "sandbox">("files");
  const [draft, setDraft] = useState("");
  const [stream, setStream] = useState<Record<string, string>>({});
  const [pendingPermissions, setPendingPermissions] = useState<Array<{ requestId: string; tool: string; input: Record<string, unknown> }>>([]);
  const [notice, setNotice] = useState<string>();
  const sessionEventSeq = useRef<Record<string, number>>({});
  const globalSeq = useRef(0);
  const activeSeq = Math.max(currentId ? (sessionEventSeq.current[currentId] ?? 0) : 0, globalSeq.current);
  const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions });
  const detail = useQuery({ queryKey: queryKeys.detail(currentId ?? ""), queryFn: () => api.session(currentId!), enabled: Boolean(currentId) });
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const context = useQuery({ queryKey: ["context", currentId], queryFn: () => api.context(currentId!), enabled: Boolean(currentId) });
  const checkpoints = useQuery({ queryKey: ["checkpoints", currentId], queryFn: () => api.checkpoints(currentId!), enabled: Boolean(currentId) });
  const steering = useQuery({ queryKey: ["steering", currentId], queryFn: () => api.steering(currentId!), enabled: Boolean(currentId) });

  useEffect(() => {
    if (!currentId && sessions.data?.[0]) setCurrentId(sessions.data[0].id);
  }, [currentId, sessions.data]);

  useEffect(() => {
    let retry = 0;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    const connect = (): void => {
      const query = new URLSearchParams({ after: String(activeSeq), ...(currentId ? { sessionId: currentId } : {}) });
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events?${query}`);
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as AppEvent;
        // connected/resync 等无 seq 帧不算真实事件，跳过水位推进
        if (typeof event.seq === "number" && event.seq > globalSeq.current) globalSeq.current = event.seq;
        if (event.sessionId && event.seq > (sessionEventSeq.current[event.sessionId] ?? 0)) {
          sessionEventSeq.current = { ...sessionEventSeq.current, [event.sessionId]: event.seq };
        }
        if (event.type === "resync.required") {
          if (typeof event.seq === "number" && event.seq > globalSeq.current) globalSeq.current = event.seq;
          queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId ?? "") });
          queryClient.invalidateQueries({ queryKey: ["context", currentId] });
          queryClient.invalidateQueries({ queryKey: ["checkpoints", currentId] });
          return;
        }
        if (!event.sessionId || event.sessionId !== currentId) return;
        if (event.type === "message.delta") {
          const text = (event.payload as { text?: string }).text ?? "";
          setStream((value) => ({ ...value, [event.sessionId!]: `${value[event.sessionId!] ?? ""}${text}` }));
        }
        if (event.type === "permission.request") {
          const req = event.payload as { requestId: string; tool: string; input: Record<string, unknown> };
          setPendingPermissions((prev) => [...prev.filter((item) => item.requestId !== req.requestId), req]);
        }
        if (["steering.queued", "steering.applied", "steering.removed"].includes(event.type)) {
          queryClient.invalidateQueries({ queryKey: ["steering", event.sessionId] });
        }
        if (["agent.state", "tool.end", "checkpoint.created", "checkpoint.restored", "context.usage"].includes(event.type)) {
          queryClient.invalidateQueries({ queryKey: queryKeys.detail(event.sessionId) });
          queryClient.invalidateQueries({ queryKey: ["context", event.sessionId] });
          queryClient.invalidateQueries({ queryKey: ["checkpoints", event.sessionId] });
          if (event.type === "agent.state" && (event.payload as { state?: string }).state === "idle") setStream((value) => ({ ...value, [event.sessionId!]: "" }));
        }
      };
      socket.onclose = () => {
        timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => { socket?.close(); if (timer) window.clearTimeout(timer); };
  }, [currentId, queryClient]);

  const current = detail.data;
  const running = Boolean(stream[currentId ?? ""]);
  const send = useMutation({
    mutationFn: async () => {
      if (!currentId || !draft.trim()) return;
      return api.sendMessage(currentId, draft.trim());
    },
    onSuccess: (result) => {
      setDraft("");
      if (result?.queued) setNotice(`已加入 Steering 队列（第 ${result.position} 项）`);
      queryClient.invalidateQueries({ queryKey: queryKeys.detail(currentId ?? "") });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "发送失败"),
  });
  const create = useMutation({
    mutationFn: () => {
      const cwd = window.prompt("输入工作目录（绝对路径）");
      if (!cwd?.trim()) throw new Error("必须提供工作目录");
      return api.createSession({ cwd: cwd.trim(), provider: providers.data?.[0]?.name ?? "development", model: models.data?.[0]?.id ?? "claude-opus-4-8", title: "新作业" });
    },
    onSuccess: (session) => { setCurrentId(session.id); queryClient.invalidateQueries({ queryKey: queryKeys.sessions }); },
    onError: (error) => setNotice(error instanceof Error ? error.message : "创建会话失败"),
  });
  const model = useMemo(() => models.data?.find((item) => item.id === current?.model), [models.data, current?.model]);

  return <main className="console-shell">
    <aside className="session-rail" aria-label="会话">
      <header><span className="mark">OWC</span><button className="icon-button" onClick={() => create.mutate()} aria-label="新建会话">＋</button></header>
      <div className="rail-label">作业 / SESSIONS</div>
      <nav>{sessions.data?.map((session) => <button key={session.id} className={`session-link ${session.id === currentId ? "active" : ""}`} onClick={() => setCurrentId(session.id)}><span className="session-dot"/><span><b>{session.title}</b><small>{session.provider} · {session.model}</small></span></button>)}</nav>
      <footer><span className="status-dot"/> 本地执行器在线</footer>
    </aside>
    <section className="workbench">
      {current ? <>
        <header className="job-header"><div><div className="eyebrow">WORKSPACE / {current.cwd}</div><h1>{current.title}</h1></div><div className="header-badges"><span className={`sandbox ${current.sandbox?.enabled ? "enforced" : "advisory"}`}>🛡 {current.sandbox?.enabled ? "SANDBOX" : "SANDBOX OFF"}</span><button className="abort" onClick={() => api.abort(current.id).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "无法中断"))}>中断</button></div></header>
        <div className="execution-track">
          {current.messages.map((message) => <MessageCard key={message.id} message={message}/>) }
          {stream[current.id] && <article className="message assistant live"><span className="track-node"/><div className="message-meta">OPENWEBCODE · 正在输出</div><ReactMarkdown>{stream[current.id]}</ReactMarkdown><span className="cursor"/></article>}
          {pendingPermissions.map((perm) => <PermissionCard key={perm.requestId} permission={perm} sessionId={current.id} onDone={() => setPendingPermissions((prev) => prev.filter((item) => item.requestId !== perm.requestId))} />)}
        </div>
        {steering.data && steering.data.length > 0 && <div className="steering-queue"><b>Steering 队列</b>{steering.data.map((item, index) => <div key={item.id}><span>{index + 1}</span><p>{item.content}</p><button onClick={() => api.removeSteering(current.id, item.id).then(() => steering.refetch())}>撤销</button></div>)}</div>}
        <Composer current={current} model={model} models={models.data ?? []} draft={draft} setDraft={setDraft} onSend={() => send.mutate()} onConfig={(body) => {
          api.updateSession(current.id, body)
            .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.detail(current.id) }))
            .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "配置失败"));
        }} running={running || send.isPending}/>
      </> : <EmptyState />}
    </section>
    <Inspector id={currentId} current={current} panel={panel} setPanel={setPanel} context={context.data} checkpoints={checkpoints.data} onNotice={setNotice}/>
    {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice(undefined)}>×</button></div>}
  </main>;
}

function MessageCard({ message }: { message: ChatMessage }): ReactElement {
  return <article className={`message ${message.role}`}><span className="track-node"/><div className="message-meta">{message.role === "user" ? "你" : message.role === "assistant" ? "OPENWEBCODE" : "工具结果"} · {new Date(message.createdAt).toLocaleTimeString()}</div>{message.content.map((block, index) => {
    if (block.type === "text") return <ReactMarkdown key={index}>{block.text ?? ""}</ReactMarkdown>;
    if (block.type === "thinking") return <details key={index} className="thinking"><summary>思考过程</summary><pre>{block.text}</pre></details>;
    if (block.type === "tool_call") return <ToolCard key={index} name={block.name ?? "tool"} input={block.input}/>;
    return <ToolResult key={index} content={block.content ?? ""} error={Boolean(block.isError)}/>;
  })}</article>;
}
function ToolCard({ name, input }: { name: string; input?: Record<string, unknown> }): ReactElement { return <section className="tool-card"><div><span>工具</span><b>{name}</b></div><pre>{JSON.stringify(input, null, 2)}</pre></section>; }
function ToolResult({ content, error }: { content: string; error: boolean }): ReactElement { return <section className={`tool-result ${error ? "error" : ""}`}><span>{error ? "执行失败" : "执行结果"}</span><pre>{content}</pre></section>; }
function PermissionCard({ permission, sessionId, onDone }: { permission: { requestId: string; tool: string; input: Record<string, unknown> }; sessionId: string; onDone(): void }): ReactElement {
  const [reason, setReason] = useState(""); const decide = (decision: "allow" | "allow_always" | "deny") => api.respondPermission(sessionId, { requestId: permission.requestId, decision, ...(reason ? { reason } : {}) }).then(onDone);
  return <article className="permission-card"><span className="track-node"/><div className="message-meta">需要你的确认</div><h2>允许 {permission.tool} 吗？</h2><pre>{JSON.stringify(permission.input, null, 2)}</pre><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="拒绝理由（可选）"/><div><button onClick={() => decide("allow")}>允许一次</button><button onClick={() => decide("allow_always")}>总是允许</button><button className="deny" onClick={() => decide("deny")}>拒绝</button></div></article>;
}
function Composer({ current, model, models, draft, setDraft, onSend, onConfig, running }: { current: SessionDetail; model?: ModelProfile; models: ModelProfile[]; draft: string; setDraft(value: string): void; onSend(): void; onConfig(body: Record<string, unknown>): void; running: boolean }): ReactElement { return <footer className="composer"><div className="config-row"><label>模型<select value={current.model} disabled={running} onChange={(event) => onConfig({ model: event.target.value })}>{models.filter((item) => item.provider === current.provider).map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><label>思考<select value={current.thinking ?? "disabled"} disabled={running} onChange={(event) => onConfig({ thinking: event.target.value === "disabled" ? null : event.target.value })}>{(model?.capabilities.thinking ?? ["disabled"]).map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>权限<select value={current.permissionMode ?? "ask"} disabled={running} onChange={(event) => onConfig({ permissionMode: event.target.value })}><option value="ask">每次确认</option><option value="acceptEdits">接受编辑</option><option value="yolo">YOLO</option></select></label>{running && <span className="steering-hint">下一条消息将加入 Steering</span>}</div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSend(); } }} placeholder={running ? "向正在执行的作业补充指令…" : "描述要完成的编码任务…"}/><button className="send" disabled={!draft.trim()} onClick={onSend}>{running ? "加入 Steering ↗" : "发送任务 ↗"}</button></footer>; }
const joinPath = (base: string, name: string): string => base === "." ? name : `${base}/${name}`;
function Inspector({ id, current, panel, setPanel, context, checkpoints, onNotice }: { id?: string; current?: Session; panel: string; setPanel(value: "files" | "context" | "timeline" | "sandbox"): void; context?: import("./lib/contracts").ContextView; checkpoints?: import("./lib/contracts").Checkpoint[]; onNotice(value: string): void }): ReactElement { const [directory, setDirectory] = useState("."); const [selectedFile, setSelectedFile] = useState<string>(); const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>(); const files = useQuery({ queryKey: ["files", id, directory], queryFn: () => api.listFiles(id!, directory), enabled: Boolean(id) }); const preview = useQuery({ queryKey: ["file", id, selectedFile], queryFn: () => api.readFile(id!, selectedFile!), enabled: Boolean(id && selectedFile) }); const checkpointDiff = useQuery({ queryKey: ["checkpoint-diff", id, selectedCheckpoint], queryFn: () => api.checkpointDiff(id!, selectedCheckpoint!), enabled: Boolean(id && selectedCheckpoint) }); return <aside className="inspector"><div className="tabs">{(["files", "context", "timeline", "sandbox"] as const).map((item) => <button className={panel === item ? "active" : ""} onClick={() => setPanel(item)} key={item}>{({ files: "文件", context: "上下文", timeline: "时间线", sandbox: "沙盒" })[item]}</button>)}</div>{panel === "files" && <div className="inspector-body"><h2>工作区</h2><div className="path-bar"><button disabled={directory === "."} onClick={() => setDirectory(directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : ".")}>←</button><span>{directory}</span></div>{files.data?.entries.map((entry) => <button className="file-row" key={entry.name} onClick={() => entry.type === "directory" ? setDirectory(joinPath(directory, entry.name)) : setSelectedFile(joinPath(directory, entry.name))}><span>{entry.type === "directory" ? "□" : "—"}</span>{entry.name}<small>{entry.size}</small></button>) ?? <p>选择会话以加载文件。</p>}{selectedFile && <section className="file-preview"><header>{selectedFile}<button onClick={() => setSelectedFile(undefined)}>×</button></header>{preview.isError ? <p>无法读取该文件。</p> : <pre>{preview.data?.content ?? "加载中…"}</pre>}</section>}</div>}{panel === "context" && <div className="inspector-body"><h2>上下文水位</h2>{context ? <><div className="usage-bar"><i style={{ width: `${Math.min(100, (context.ledger.usage.inputTokens + context.ledger.usage.outputTokens) / 1000)}%` }}/></div><p>{context.ledger.usage.inputTokens + context.ledger.usage.outputTokens} tokens</p><dl><dt>缓存读</dt><dd>{context.ledger.usage.cacheRead}</dd><dt>人民币</dt><dd>{formatCurrency(context.ledger.cost.cnyMicroUnits, "CNY")}</dd><dt>美元</dt><dd>{formatCurrency(context.ledger.cost.usdMicroUnits, "USD")}</dd></dl></> : <p>暂无用量。</p>}</div>}{panel === "timeline" && <div className="inspector-body"><h2>检查点</h2>{checkpoints?.map((checkpoint) => <div className="checkpoint" key={checkpoint.id}><button className="checkpoint-label" onClick={() => setSelectedCheckpoint(checkpoint.id)}>{checkpoint.label}</button><small>{new Date(checkpoint.createdAt).toLocaleString()}</small><div><button onClick={() => { if (confirm(`完整回滚到「${checkpoint.label}」？文件和对话将同步恢复。`)) api.restoreCheckpoint(id!, checkpoint.id).then(() => onNotice("已完整恢复检查点")).catch((error: unknown) => onNotice(error instanceof Error ? error.message : "回滚失败")); }}>完整回滚</button><button onClick={() => { if (confirm(`仅恢复「${checkpoint.label}」的文件？对话不会截断。`)) api.restoreCheckpoint(id!, checkpoint.id, true).then(() => onNotice("已仅恢复文件")).catch((error: unknown) => onNotice(error instanceof Error ? error.message : "回滚失败")); }}>仅文件</button></div>{selectedCheckpoint === checkpoint.id && <pre className="checkpoint-diff">{checkpointDiff.data?.diff ?? "加载 diff…"}</pre>}</div>) ?? <p>暂无检查点。</p>}</div>}{panel === "sandbox" && <div className="inspector-body"><h2>策略</h2>{current?.sandbox ? <dl><dt>状态</dt><dd>{current.sandbox.enabled ? "已启用" : "已关闭"}</dd><dt>网络</dt><dd>{current.sandbox.network}</dd><dt>写入根</dt><dd>{current.sandbox.writeRoots.join("\n")}</dd><dt>拒绝路径</dt><dd>{current.sandbox.denyPaths.join("\n") || "—"}</dd></dl> : <p>未配置策略。</p>}</div>}</aside>; }
function EmptyState(): ReactElement { return <section className="empty-state"><span>OWC / 01</span><h1>开始一项<br/>可回滚的编码作业。</h1><p>从左侧创建会话，选择一个工作目录后，OpenWebCode 会在执行轨道上记录每一次决策。</p></section>; }
