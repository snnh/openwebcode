#!/usr/bin/env node
/**
 * 构建后为 dist 生成 `.br` 同伴文件：server 侧 @fastify/static 的 preCompressed 直接发送，
 * 运行期零压缩 CPU；客户端不支持 br（或同伴缺失）时自动回落原文件。
 *
 * 只压文本类资产并跳过已压缩格式（png/woff2/map 等）。质量取 5：体积与构建耗时的平衡点，
 * 单文件最大 4 MB（monaco）也在秒级完成。
 */
import { constants, brotliCompress } from "node:zlib";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "../dist");
const EXTENSIONS = new Set([".js", ".css", ".html", ".json", ".svg", ".webmanifest", ".txt", ".xml"]);
const MIN_BYTES = 1024;

const compress = promisify(brotliCompress);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let count = 0;
let rawBytes = 0;
let compressedBytes = 0;
for await (const file of walk(ROOT)) {
  if (!EXTENSIONS.has(path.extname(file))) continue;
  const raw = await readFile(file);
  if (raw.length < MIN_BYTES) continue;
  const packed = await compress(raw, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
  });
  await writeFile(`${file}.br`, packed);
  count += 1;
  rawBytes += raw.length;
  compressedBytes += packed.length;
}

const ratio = rawBytes === 0 ? 0 : Math.round((1 - compressedBytes / rawBytes) * 100);
process.stdout.write(
  `[precompress] ${count} 个文件产出 .br：${(rawBytes / 1024 / 1024).toFixed(1)} MB → ${(compressedBytes / 1024 / 1024).toFixed(1)} MB（省 ${ratio}%）\n`,
);
