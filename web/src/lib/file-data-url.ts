/**
 * 文件 → data URL 的 Promise 封装与剪贴板文件提取。
 * workbench Composer（图片/PDF 附件）与 chat 模式 ChatComposer（图片附件）共用。
 */

/** FileReader.readAsDataURL 的 Promise 封装，resolve 完整 data URL（data:<mediaType>;base64,<data>）。 */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file"));
    reader.readAsDataURL(file);
  });
}

/** 从完整 data URL 中取出 base64 载荷（逗号之后的部分）。 */
export function dataUrlBase64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** 粘贴/拖拽事件中的文件列表（无文件时为空数组）。 */
export function clipboardFiles(event: { clipboardData?: DataTransfer | null }): File[] {
  return [...(event.clipboardData?.files ?? [])];
}
