/**
 * dsh-sync 扩展 M4a：图片字节 → 尺寸/媒体类型的纯解析模块（无 IO、无副作用）。
 *
 * 为什么需要它：导出到 dsh 时图片块必须带真实 `width`/`height`（dsh 的 image attachment 校验要求
 * `attachmentId`/`mediaType`/`bytes`/`width`/`height` 齐备且宽高为正整数，见上游
 * `session-format-v0-to-v1/src/payload-validation.ts` 的 `imageAttachmentValue`），
 * 而 owc 消息里只有 base64 字节与媒体类型字符串；本模块只按魔术字节解析，不信任调用方给的类型。
 *
 * 与 `server/src/dsh/web-protocol/session-projection.ts` 的 `imageDimensions(mediaType, bytes)` 的分工：
 * 那个是 dsh 兼容层（wire 投影）的入口且要求媒体类型已给出；本模块按内容嗅探，供导出/导入侧复用。
 * 两处解析实现刻意保持独立：M4 的 wire 行为已由既有测试锁定，M4a 不改动它（避免回归）。
 *
 * 解析失败（非图片、字节截断、结构非法）一律返回 undefined，不抛错。
 */

/** dsh 附件层接受的四种栅格图片媒体类型（上游 `dsh-attachment` 的 `ImageMediaType`）。 */
export type DshImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** 图片尺寸（像素）。 */
export interface DshImageSize {
  width: number;
  height: number;
}

/** PNG 文件签名（8 字节）。 */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** JPEG 段起始标记与文件起始标记。 */
const JPEG_MARKER = 0xff;
const JPEG_SOI = 0xd8;
const JPEG_TEM = 0x01;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;

/** SOF0–SOF15 中不是图片尺寸头的三个保留标记（DHT / JPG / DAC）。 */
const JPEG_NON_FRAME_MARKERS: readonly number[] = [0xc4, 0xc8, 0xcc];

/** WebP 容器与三种 chunk 的标识。 */
const WEBP_RIFF = "RIFF";
const WEBP_TAG = "WEBP";
const WEBP_VP8 = "VP8 ";
const WEBP_VP8L = "VP8L";
const WEBP_VP8X = "VP8X";

/** VP8 关键帧起始码（无符号小端 0x9d012a），出现在 3 字节帧标签之后。 */
const VP8_START_CODE: readonly number[] = [0x9d, 0x01, 0x2a];

/** VP8L 有损/无损共用的 0x2f 签名字节。 */
const VP8L_SIGNATURE = 0x2f;

/** 取 14 位位域（VP8 宽高与 VP8L 位打包都用它）。 */
const WEBP_14BIT_MASK = 0x3fff;

/** 字节区间是否落在 buffer 内（含边界校验，避免越界读抛错）。 */
function hasBytes(bytes: Buffer, from: number, count: number): boolean {
  return from >= 0 && count >= 0 && from + count <= bytes.length;
}

/** PNG：签名 + 第 0 个 chunk 必须是 IHDR（宽高为两段大端 32 位）。 */
function pngSize(bytes: Buffer): DshImageSize | undefined {
  if (!hasBytes(bytes, 0, 24)) return undefined;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return undefined;
  }
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** GIF：GIF87a/GIF89a + 逻辑屏幕描述符里的宽高（小端 16 位）。 */
function gifSize(bytes: Buffer): DshImageSize | undefined {
  if (!hasBytes(bytes, 0, 10)) return undefined;
  const signature = bytes.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/** JPEG 无载荷标记：SOI / TEM / RSTn（它们没有 2 字节长度字段）。 */
function isJpegStandaloneMark(marker: number): boolean {
  return marker === JPEG_SOI || marker === JPEG_TEM || (marker >= 0xd0 && marker <= 0xd7);
}

/** JPEG 是否 SOF0–SOF15 中的尺寸头。 */
function isJpegFrameMark(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_FRAME_MARKERS.includes(marker);
}

/**
 * JPEG：从 SOI 起逐段扫描，跳过 APPn/COM/DQT 等带长度字段的段，命中 SOFn 取宽高。
 * 遇到 SOS（其后是熵编码数据）或 EOI 仍未见 SOF 则放弃。
 */
function jpegSize(bytes: Buffer): DshImageSize | undefined {
  if (!hasBytes(bytes, 0, 4)) return undefined;
  if (bytes[0] !== JPEG_MARKER || bytes[1] !== JPEG_SOI) return undefined;
  let offset = 2;
  while (hasBytes(bytes, offset, 4)) {
    if (bytes[offset] !== JPEG_MARKER) {
      // 段间填充/异常字节：逐字节前进，不猜结构。
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === JPEG_MARKER) {
      offset += 1;
      continue;
    }
    if (isJpegStandaloneMark(marker)) {
      offset += 2;
      continue;
    }
    if (marker === JPEG_EOI || marker === JPEG_SOS) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (isJpegFrameMark(marker)) {
      // SOFn 载荷：长度(2) + 精度(1) + 高(2) + 宽(2) …
      if (!hasBytes(bytes, offset, 9)) return undefined;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

/** WebP：RIFF 容器内的 VP8（有损关键帧）/ VP8L（无损）/ VP8X（扩展）三种 chunk。 */
function webpSize(bytes: Buffer): DshImageSize | undefined {
  if (!hasBytes(bytes, 0, 16)) return undefined;
  if (bytes.toString("latin1", 0, 4) !== WEBP_RIFF || bytes.toString("latin1", 8, 12) !== WEBP_TAG) return undefined;
  const format = bytes.toString("latin1", 12, 16);
  if (format === WEBP_VP8X) {
    // 24 字节处起 3 字节小端「画布宽-1」、再 3 字节「画布高-1」。
    if (!hasBytes(bytes, 24, 6)) return undefined;
    return { width: 1 + (bytes.readUIntLE(24, 3) & 0xffffff), height: 1 + (bytes.readUIntLE(27, 3) & 0xffffff) };
  }
  if (format === WEBP_VP8) {
    // 帧标签(3) + 起始码(3) 之后是 14 位宽、14 位高。
    if (!hasBytes(bytes, 20, 10)) return undefined;
    for (let i = 0; i < VP8_START_CODE.length; i++) {
      if (bytes[23 + i] !== VP8_START_CODE[i]) return undefined;
    }
    return { width: bytes.readUInt16LE(26) & WEBP_14BIT_MASK, height: bytes.readUInt16LE(28) & WEBP_14BIT_MASK };
  }
  if (format === WEBP_VP8L) {
    // 0x2f 签名 + 小端 32 位位打包：低 14 位宽-1，其次 14 位高-1（均 +1 还原）。
    if (!hasBytes(bytes, 21, 4)) return undefined;
    if (bytes[20] !== VP8L_SIGNATURE) return undefined;
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & WEBP_14BIT_MASK), height: 1 + ((bits >> 14) & WEBP_14BIT_MASK) };
  }
  return undefined;
}

/**
 * 解析图片字节的真实尺寸（PNG / GIF / JPEG / WebP）。
 * @param bytes - 图片文件全部字节（截断也能尽力解析，解析不出返回 undefined）。
 * @returns 宽高像素；非图片或结构非法时 undefined（不抛错）。
 */
export function imageSize(bytes: Buffer): DshImageSize | undefined {
  return pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}

/**
 * 从字节嗅探媒体类型（与 {@link imageSize} 同一套魔术字节判定）。
 *
 * 导出侧以字节为权威：dsh 的附件存储校验「mediaType 必须与落盘字节一致」，
 * 直接透传 owc 消息里的 mediaType 字符串可能与之冲突，因此这里按内容判定。
 * @param bytes - 图片文件全部字节。
 * @returns dsh 支持的四种媒体类型之一；识别不出时 undefined。
 */
export function imageMediaType(bytes: Buffer): DshImageMediaType | undefined {
  if (pngSize(bytes) !== undefined) return "image/png";
  if (gifSize(bytes) !== undefined) return "image/gif";
  if (jpegSize(bytes) !== undefined) return "image/jpeg";
  if (webpSize(bytes) !== undefined) return "image/webp";
  return undefined;
}
