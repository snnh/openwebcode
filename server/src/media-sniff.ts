/**
 * 媒体类型嗅探（read_media）：魔数（magic bytes）为权威判定，扩展名仅作视频兜底
 * （MPEG-PS/TS 等裸流没有可靠自描述头）。扩展名与魔数冲突时信魔数；
 * 两者都判不出时返回 undefined（调用方报「无法识别的媒体格式」）。
 */

export type MediaKind = "image" | "video";

export interface SniffedMedia {
  kind: MediaKind;
  mediaType: string;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[offset + index]!);
  }
  return out;
}

/** 视频扩展名 → mediaType 兜底表（仅魔数判不出时使用；裸流格式走这里）。 */
const VIDEO_EXTENSION_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  flv: "video/x-flv",
  ts: "video/mp2t",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
};

function extensionOf(pathHint: string | undefined): string | undefined {
  if (!pathHint) return undefined;
  const clean = (pathHint.split(/[?#]/, 1)[0] ?? "").replace(/\\/g, "/");
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? undefined : base.slice(dot + 1).toLowerCase();
}

export function sniffMedia(bytes: Uint8Array, pathHint?: string): SniffedMedia | undefined {
  // 图片魔数（唯一判定依据，不做扩展名兜底：伪图不应进模型）
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { kind: "image", mediaType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", mediaType: "image/jpeg" };
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return { kind: "image", mediaType: "image/gif" };
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return { kind: "image", mediaType: "image/webp" };

  // ISO-BMFF（mp4/mov/3gp…）：偏移 4 起 "ftyp"，主 brand 在偏移 8
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    // avif/heic/heix 是图片容器，但不在图片投递白名单内（provider 仅认 png/jpeg/gif/webp），按未知处理
    if (brand === "avif" || brand === "heic" || brand === "heix") return undefined;
    if (brand.startsWith("3gp")) return { kind: "video", mediaType: "video/3gpp" };
    if (brand.startsWith("3g2")) return { kind: "video", mediaType: "video/3gpp2" };
    if (brand === "qt  ") return { kind: "video", mediaType: "video/quicktime" };
    return { kind: "video", mediaType: "video/mp4" };
  }
  // EBML 头（webm/mkv 同一容器族，按 webm 投递）
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { kind: "video", mediaType: "video/webm" };
  // RIFF AVI
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "AVI ") return { kind: "video", mediaType: "video/x-msvideo" };
  // FLV
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "FLV") return { kind: "video", mediaType: "video/x-flv" };
  // MPEG-PS pack start code
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0xba) return { kind: "video", mediaType: "video/mpeg" };
  // MPEG-TS：188 字节定长包的同步字 0x47，校验前三个包位防误判
  if (bytes.length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) return { kind: "video", mediaType: "video/mp2t" };

  // 魔数判不出的视频按扩展名兜底（魔数已命中时不会走到这里：魔数优先）
  const byExtension = VIDEO_EXTENSION_TYPES[extensionOf(pathHint) ?? ""];
  return byExtension ? { kind: "video", mediaType: byExtension } : undefined;
}
