// 假 MCP stdio server：tools/call "env" 回显子进程实际收到的环境变量（JSON），用于 env 白名单测试。
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    if (msg.method === "initialize") {
      send({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-env", version: "1.0.0" } });
    } else if (msg.method === "tools/list") {
      send({ tools: [{ name: "env", description: "回显环境变量", inputSchema: { type: "object", properties: {} } }] });
    } else if (msg.method === "tools/call") {
      send({ content: [{ type: "text", text: JSON.stringify(process.env) }] });
    }
  }
});
