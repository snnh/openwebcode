// 固定数据集生成器：长历史会话（5000 消息 / 1000 工具块）。
// 内容全部由固定 seed 的 PRNG 生成，跨机器逐字节可重复。
// 用法：server/node_modules/.bin/tsx scripts/bench/generate-dataset.mjs
// 输出：scripts/bench/data/long-history/.sessions/<id>/{meta.json,messages.jsonl}（已 gitignore）

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, mulberry32, pseudoText } from "./lib/common.mjs";

const SEED = 20260724; // 固定 seed，改动即新数据集
const MESSAGE_COUNT = 5000;
const TOOL_BLOCK_COUNT = 1000; // tool_call + tool_result 合计
// 每 10 条消息一组：8 条文本对话 + 1 条 tool_call + 1 条 tool_result → 500 组 × 2 = 1000 工具块
const GROUP_SIZE = MESSAGE_COUNT / (TOOL_BLOCK_COUNT / 2); // = 10

// 合法 session id（session-store 校验 ^[0-9a-f-]{36}$）
const SESSION_ID = "01234567-89ab-4def-8012-3456789abcde";
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

function makeId(rng) {
  // 确定性伪 uuid
  const hex = () => Math.floor(rng() * 16).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join("");
  return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`;
}

async function main() {
  const rng = mulberry32(SEED >>> 0);
  const outRoot = path.join(DATA_DIR, "long-history", ".sessions");
  const sessionDir = path.join(outRoot, SESSION_ID);
  await rm(sessionDir, { recursive: true, force: true });
  await mkdir(sessionDir, { recursive: true });

  const lines = [];
  let prevId;
  let toolBlocks = 0;
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const inGroup = i % GROUP_SIZE;
    const msg = {
      id: makeId(rng),
      createdAt: new Date(BASE_TIME + i * 1000).toISOString(),
      ...(prevId ? { parentId: prevId } : {}),
    };
    if (inGroup === GROUP_SIZE - 2) {
      // 每条消息只放一个 tool_call 块
      msg.role = "assistant";
      msg.content = [
        { type: "text", text: pseudoText(rng, 120) },
        { type: "tool_call", id: `call_${i}`, name: "read_file", input: { path: `src/file-${i}.ts`, offset: i * 10, limit: 200 } },
      ];
      toolBlocks += 1;
    } else if (inGroup === GROUP_SIZE - 1) {
      msg.role = "tool";
      msg.content = [
        { type: "tool_result", toolCallId: `call_${i - 1}`, content: pseudoText(rng, 1500), isError: false },
      ];
      toolBlocks += 1;
    } else {
      msg.role = inGroup % 2 === 0 ? "user" : "assistant";
      msg.content = [{ type: "text", text: pseudoText(rng, 200 + Math.floor(rng() * 400)) }];
    }
    prevId = msg.id;
    lines.push(JSON.stringify(msg));
  }
  if (toolBlocks !== TOOL_BLOCK_COUNT) throw new Error(`工具块数量不符：${toolBlocks} != ${TOOL_BLOCK_COUNT}`);

  const now = new Date(BASE_TIME + MESSAGE_COUNT * 1000).toISOString();
  const meta = {
    id: SESSION_ID,
    cwd: "D:/bench/fixture",
    provider: "bench",
    model: "bench-model",
    title: "bench long-history fixture",
    createdAt: new Date(BASE_TIME).toISOString(),
    updatedAt: now,
    activeLeafId: prevId,
  };
  await writeFile(path.join(sessionDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await writeFile(path.join(sessionDir, "messages.jsonl"), lines.join("\n") + "\n", "utf8");

  const bytes = Buffer.byteLength(lines.join("\n"), "utf8");
  console.log(`数据集已生成：${path.relative(process.cwd(), sessionDir)}`);
  console.log(`  消息 ${MESSAGE_COUNT} 条，工具块 ${toolBlocks} 个，messages.jsonl ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
}

await main();
