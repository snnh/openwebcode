#!/usr/bin/env node
/**
 * openwebcode filtered 网络档 sidecar 代理（纯 Node，无依赖，Node 20+ 直接运行）。
 *
 * 部署形态：与被过滤的业务进程同处一个 AppContainer 包（同包 loopback 互通），
 * 业务进程授不到 internetClient，经 HTTP_PROXY 指向本代理出网；本进程由 core 以
 * network=allow 覆盖启动，持有 internetClient + privateNetworkClientServer。
 *
 * 能力：
 * - HTTP 代理：CONNECT 隧道（HTTPS）+ 明文 HTTP 转发；监听 127.0.0.1:0，
 *   就绪后 stdout 打印一行 `OWC_PROXY_PORT <port>`（server 解析），此后日志一律 stderr。
 * - deny 清单：env OWC_PROXY_DENY_FILE 指向的文件，每行一个域名后缀（# 注释、空行忽略）；
 *   每请求前检查 mtime，变化即重读（热生效）；精确或后缀匹配命中 → 403 + stderr `[deny] <host>`。
 * - 上游接力：env OWC_UPSTREAM_PROXY（完整 URL，可含 user:pass）非空时 CONNECT 与
 *   明文 HTTP 都经该上游 HTTP 代理接力（CONNECT 到上游，支持 Proxy-Authorization basic）。
 * - 目标不可达/超时（30s）→ 502；SIGTERM/SIGINT 平滑关闭监听与活动连接。
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";

const CONNECT_TIMEOUT_MS = 30_000;

const log = (line) => {
  try {
    process.stderr.write(`[sandbox-proxy] ${line}\n`);
  } catch { /* stderr 不可写时静默 */ }
};

// ---- deny 清单（mtime 热重读） ------------------------------------------------

const denyFile = process.env.OWC_PROXY_DENY_FILE?.trim() ?? "";
let denyMtimeMs = -1;
let denyList = [];

function reloadDenyIfChanged() {
  if (!denyFile) return;
  let stat;
  try {
    stat = fs.statSync(denyFile);
  } catch {
    // 文件缺失/不可读：视为空清单（不因此阻断流量；server 侧会在 ensure 时写入）
    if (denyMtimeMs !== 0) {
      denyMtimeMs = 0;
      denyList = [];
    }
    return;
  }
  if (stat.mtimeMs === denyMtimeMs) return;
  denyMtimeMs = stat.mtimeMs;
  try {
    denyList = fs.readFileSync(denyFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line !== "" && !line.startsWith("#"));
  } catch (error) {
    denyList = [];
    log(`deny 清单读取失败，按空清单处理：${error instanceof Error ? error.message : String(error)}`);
  }
}

function isDenied(hostname) {
  reloadDenyIfChanged();
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return denyList.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

// ---- 上游代理 ----------------------------------------------------------------

let upstream = null;
const upstreamRaw = process.env.OWC_UPSTREAM_PROXY?.trim() ?? "";
if (upstreamRaw !== "") {
  try {
    upstream = new URL(upstreamRaw);
    if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
      log(`OWC_UPSTREAM_PROXY 仅支持 http/https，忽略：scheme=${upstream.protocol}`);
      upstream = null;
    }
  } catch {
    log("OWC_UPSTREAM_PROXY 不是合法 URL，按直连处理");
  }
}
const upstreamAuth = upstream && (upstream.username !== "" || upstream.password !== "")
  ? `Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString("base64")}`
  : null;
const upstreamPort = () => Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);

// 上游连接：http 上游明文，https 上游 TLS。
function openUpstreamSocket() {
  const port = upstreamPort();
  if (upstream.protocol === "https:") return tls.connect({ host: upstream.hostname, port, servername: upstream.hostname });
  return net.connect({ host: upstream.hostname, port });
}

// 经上游的 CONNECT 隧道：先对上游发 CONNECT，确认 200 后把 socket 交给调用方管道。
function connectViaUpstream(targetHost, targetPort, onEstablished) {
  const socket = openUpstreamSocket();
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  let buffer = Buffer.alloc(0);
  let settled = false;
  const fail = (reason) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    onEstablished(reason, null);
  };
  socket.once("timeout", () => fail(new Error("upstream connect timeout")));
  socket.once("error", (error) => fail(error));
  socket.once(upstream.protocol === "https:" ? "secureConnect" : "connect", () => {
    const lines = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
    ];
    if (upstreamAuth) lines.push(`Proxy-Authorization: ${upstreamAuth}`);
    lines.push("\r\n");
    socket.write(lines.join("\r\n"));
  });
  socket.on("data", (chunk) => {
    if (settled) return;
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buffer.length > 16 * 1024) fail(new Error("upstream response headers too large"));
      return;
    }
    settled = true;
    socket.setTimeout(0);
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("timeout");
    const statusLine = buffer.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
    const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
    const status = match ? Number(match[1]) : 0;
    if (status !== 200) {
      socket.destroy();
      onEstablished(new Error(`upstream CONNECT rejected: ${statusLine || "no status"}`), null);
      return;
    }
    // 200 之后可能已带有目标侧数据（罕见）：连同剩余字节一起交出
    onEstablished(null, socket, buffer.subarray(end + 4));
  });
}

// 直连目标的 CONNECT 隧道。
function connectDirect(targetHost, targetPort, onEstablished) {
  const socket = net.connect({ host: targetHost, port: targetPort });
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  let settled = false;
  const fail = (reason) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    onEstablished(reason, null);
  };
  socket.once("timeout", () => fail(new Error("target connect timeout")));
  socket.once("error", (error) => fail(error));
  socket.once("connect", () => {
    settled = true;
    socket.setTimeout(0);
    socket.removeAllListeners("error");
    socket.removeAllListeners("timeout");
    onEstablished(null, socket, Buffer.alloc(0));
  });
}

// ---- 活动连接跟踪（平滑关闭） --------------------------------------------------

const activeSockets = new Set();
function track(socket) {
  activeSockets.add(socket);
  socket.once("close", () => activeSockets.delete(socket));
}

// ---- 代理服务器 ----------------------------------------------------------------

const server = http.createServer();

// 明文 HTTP 转发。
server.on("request", (req, res) => {
  track(req.socket);
  let target;
  try {
    target = new URL(req.url ?? "", `http://${req.headers.host ?? ""}`);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }
  const hostname = target.hostname;
  if (!hostname) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }
  if (isDenied(hostname)) {
    log(`[deny] ${hostname}`);
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Denied by sandbox proxy policy");
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  headers.host = target.host;
  let options;
  if (upstream) {
    // 接力上游：请求行保持 absolute-form，附 Proxy-Authorization
    if (upstreamAuth) headers["proxy-authorization"] = upstreamAuth;
    options = {
      host: upstream.hostname,
      port: upstreamPort(),
      method: req.method,
      path: target.href,
      headers,
      agent: false,
      // https 上游需要 TLS；http 上游明文
      createConnection: () => openUpstreamSocket(),
    };
  } else {
    options = {
      host: hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    };
  }
  const outgoing = http.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  outgoing.setTimeout(CONNECT_TIMEOUT_MS, () => outgoing.destroy(new Error("request timeout")));
  outgoing.once("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Gateway");
  });
  req.pipe(outgoing);
});

// CONNECT 隧道（HTTPS）。
server.on("connect", (req, clientSocket, head) => {
  track(clientSocket);
  const reply = (status, message) => {
    try {
      clientSocket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    } catch { /* 客户端可能已断开 */ }
    clientSocket.destroy();
  };
  const match = /^(.+):(\d+)$/.exec(req.url ?? "");
  if (!match) {
    reply(400, "Bad Request");
    return;
  }
  const targetHost = match[1];
  const targetPort = Number(match[2]);
  if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
    reply(400, "Bad Request");
    return;
  }
  if (isDenied(targetHost)) {
    log(`[deny] ${targetHost}`);
    reply(403, "Forbidden");
    return;
  }
  // 上游在回环地址时 sidecar 仍可达（sidecar 持有 privateNetworkClientServer），无需改写；
  // 回环改写由 server 编排层在计算 OWC_UPSTREAM_PROXY 时完成（面向沙盒外本机代理软件）。
  const establish = upstream ? connectViaUpstream : connectDirect;
  establish(targetHost, targetPort, (error, targetSocket, prefix) => {
    if (error || !targetSocket) {
      log(`CONNECT ${targetHost}:${targetPort} 失败：${error instanceof Error ? error.message : String(error)}`);
      reply(502, "Bad Gateway");
      return;
    }
    track(targetSocket);
    try {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (prefix && prefix.length > 0) clientSocket.write(prefix);
    } catch {
      targetSocket.destroy();
      return;
    }
    if (head && head.length > 0) targetSocket.write(head);
    clientSocket.pipe(targetSocket).pipe(clientSocket);
    clientSocket.once("error", () => targetSocket.destroy());
    targetSocket.once("error", () => clientSocket.destroy());
  });
});

server.on("clientError", (_error, socket) => {
  socket.destroy();
});

// ---- 启动与平滑关闭 ------------------------------------------------------------

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    log("监听失败：未取到端口");
    process.exit(1);
  }
  // 唯一一行 stdout：server 编排层解析该端口后注入会话 HTTP_PROXY
  process.stdout.write(`OWC_PROXY_PORT ${address.port}\n`);
  log(`listening on 127.0.0.1:${address.port}${upstream ? `，上游 ${upstream.protocol}//${upstream.host}` : "，直连"}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，平滑关闭`);
  server.close(() => process.exit(0));
  for (const socket of activeSockets) socket.destroy();
  // 兜底：server.close 等连接排空，最长 2s
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
