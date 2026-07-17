// 假 MCP stdio server：逐行 JSON-RPC，用于测试。支持 echo/fail 两个工具。
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
    if (msg.id === undefined) continue; // notifications：不回应
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    const sendError = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message } }) + "\n");
    if (msg.method === "initialize") {
      send({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } });
    } else if (msg.method === "tools/list") {
      send({
        tools: [
          { name: "echo", description: "回显输入", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
          { name: "fail", description: "总是失败", inputSchema: { type: "object", properties: {} } },
        ],
      });
    } else if (msg.method === "tools/call") {
      if (msg.params?.name === "echo") send({ content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] });
      else if (msg.params?.name === "fail") send({ content: [{ type: "text", text: "boom" }], isError: true });
      else sendError(`unknown tool ${msg.params?.name}`);
    } else {
      sendError(`unknown method ${msg.method}`);
    }
  }
});
