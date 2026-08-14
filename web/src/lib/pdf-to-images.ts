/// <reference types="vite/client" />

import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * Let Vite emit the PDF.js module worker as an asset instead of relying on a
 * CDN or a relative URL at runtime. Do not overwrite an embedding app's
 * explicit worker configuration.
 */
if (!GlobalWorkerOptions.workerSrc) {
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

interface PdfImage {
  /** Kept structurally compatible with Composer's PendingImage. */
  mediaType: "image/png";
  /** Base64 PNG payload, without the data URL prefix. */
  data: string;
  /** A directly renderable PNG data URL. */
  previewUrl: string;
}

interface PdfRenderResult {
  images: PdfImage[];
  /** The source document's page count, including pages skipped by maxPages. */
  totalPages: number;
  /** True when maxPages prevented at least one source page from rendering. */
  truncated: boolean;
}

export interface PdfRenderOptions {
  /** Maximum source pages to render. Defaults to 10. */
  maxPages?: number;
  /** Output resolution in DPI. Defaults to 150. */
  dpi?: number;
  /** Longest output edge in pixels. Defaults to 2048. */
  maxDimension?: number;
}

interface PdfRenderProgress {
  completed: number;
  total: number;
}

type PdfRenderProgressCallback = (progress: PdfRenderProgress) => void;

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_DPI = 150;
const DEFAULT_MAX_DIMENSION = 2048;
const PDF_POINTS_PER_INCH = 72;
// Must stay in sync with server/src/app.ts MAX_IMAGE_BASE64.
const MAX_IMAGE_BASE64_CHARS = 7_000_000;
const DOWNSCALE_SAFETY_FACTOR = 0.9;
// A highly incompressible page can require multiple re-renders. Keep the
// retry work bounded even when each scale reduction only removes one pixel.
const MAX_PNG_RENDER_ATTEMPTS = 10;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function releaseCanvas(canvas: HTMLCanvasElement | undefined): void {
  if (!canvas) return;
  // Resetting a canvas releases its backing store. It is intentionally not
  // appended to the DOM, so there is no object URL or node to revoke/remove.
  canvas.width = 0;
  canvas.height = 0;
}

function cleanupRenderTask(renderTask: RenderTask | undefined, renderFinished: boolean): unknown | undefined {
  let cleanupError: unknown;
  if (!renderFinished) {
    try {
      renderTask?.cancel();
    } catch (error) {
      cleanupError = error;
    }
  }
  return cleanupError;
}

function cleanupPage(page: PDFPageProxy | undefined): unknown | undefined {
  try {
    page?.cleanup();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function cleanupDocument(document: PDFDocumentProxy | undefined, loadingTask: PDFDocumentLoadingTask | undefined): Promise<unknown | undefined> {
  let cleanupError: unknown;
  try {
    await document?.destroy();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await loadingTask?.destroy();
  } catch (error) {
    cleanupError ??= error;
  }
  return cleanupError;
}

function dataFromPngUrl(previewUrl: string): string {
  const comma = previewUrl.indexOf(",");
  if (!previewUrl.startsWith("data:image/png") || comma < 0) {
    throw new Error("Failed to encode PDF page as PNG");
  }
  return previewUrl.slice(comma + 1);
}

function pageScale(baseViewport: { width: number; height: number }, dpi: number, maxDimension: number): number {
  const longestEdge = Math.max(baseViewport.width, baseViewport.height);
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) {
    throw new Error("PDF page has invalid dimensions");
  }
  return Math.min(dpi / PDF_POINTS_PER_INCH, maxDimension / longestEdge);
}

function canvasDimension(value: number, maxDimension: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("PDF page has invalid viewport dimensions");
  }
  return Math.max(1, Math.min(maxDimension, Math.floor(value)));
}

/**
 * PNG compression varies wildly with page content, so calculate the next
 * scale from the actual base64 output rather than trying to predict its size.
 * The forced one-pixel reduction prevents rounding from retrying the same
 * canvas dimensions when the payload is only slightly over the limit.
 */
function nextScaleAfterOversize(currentScale: number, baseViewport: { width: number; height: number }, base64Length: number): number | undefined {
  const longestEdge = Math.max(baseViewport.width, baseViewport.height);
  const minimumScale = 1 / longestEdge;
  if (currentScale <= minimumScale) return undefined;

  const sizeRatio = Math.min(
    DOWNSCALE_SAFETY_FACTOR,
    Math.sqrt(MAX_IMAGE_BASE64_CHARS / base64Length) * DOWNSCALE_SAFETY_FACTOR,
  );
  const currentLongestPixels = Math.max(1, Math.floor(longestEdge * currentScale));
  const forcedSmallerScale = Math.max(minimumScale, (currentLongestPixels - 1) / longestEdge);
  const nextScale = Math.max(
    minimumScale,
    Math.min(currentScale * sizeRatio, forcedSmallerScale),
  );
  return nextScale < currentScale ? nextScale : undefined;
}

interface RenderedPng {
  data: string;
  previewUrl: string;
}

async function renderPagePng(page: PDFPageProxy, scale: number, maxDimension: number): Promise<RenderedPng> {
  let renderTask: RenderTask | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let renderFinished = false;
  let renderError: unknown;

  try {
    const viewport = page.getViewport({ scale });
    canvas = globalThis.document.createElement("canvas");
    canvas.width = canvasDimension(viewport.width, maxDimension);
    canvas.height = canvasDimension(viewport.height, maxDimension);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create a canvas context for PDF rendering");

    renderTask = page.render({ canvasContext: context, viewport });
    await renderTask.promise;
    renderFinished = true;

    const previewUrl = canvas.toDataURL("image/png");
    return { data: dataFromPngUrl(previewUrl), previewUrl };
  } catch (error) {
    renderError = error;
    throw error;
  } finally {
    const renderCleanupError = cleanupRenderTask(renderTask, renderFinished);
    releaseCanvas(canvas);
    // eslint-disable-next-line no-unsafe-finally -- 仅当主流程无错时才抛清理错误，不掩盖原错误（renderError 守卫）
    if (renderError === undefined && renderCleanupError !== undefined) throw renderCleanupError;
  }
}

/**
 * Render a local PDF into PNG attachments suitable for Composer. Rendering is
 * sequential to preserve page order and keep the peak canvas memory bounded.
 */
export async function renderPdfToImages(
  file: File,
  options: PdfRenderOptions = {},
  onProgress?: PdfRenderProgressCallback,
): Promise<PdfRenderResult> {
  const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES, "maxPages");
  const dpi = positiveInteger(options.dpi, DEFAULT_DPI, "dpi");
  const maxDimension = positiveInteger(options.maxDimension, DEFAULT_MAX_DIMENSION, "maxDimension");

  let loadingTask: PDFDocumentLoadingTask | undefined;
  let document: PDFDocumentProxy | undefined;
  let operationError: unknown;

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    loadingTask = getDocument({ data });
    document = await loadingTask.promise;

    const totalPages = document.numPages;
    const pagesToRender = Math.min(totalPages, maxPages);
    const truncated = totalPages > pagesToRender;
    const images: PdfImage[] = [];
    onProgress?.({ completed: 0, total: pagesToRender });

    for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber += 1) {
      let page: PDFPageProxy | undefined;
      let pageError: unknown;

      try {
        page = await document.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        let scale = pageScale(baseViewport, dpi, maxDimension);
        let png: RenderedPng | undefined;
        for (let attempt = 1; attempt <= MAX_PNG_RENDER_ATTEMPTS; attempt += 1) {
          png = await renderPagePng(page, scale, maxDimension);
          if (png.data.length <= MAX_IMAGE_BASE64_CHARS) break;

          if (attempt === MAX_PNG_RENDER_ATTEMPTS) {
            throw new Error(`PDF page ${pageNumber} could not be reduced below the image upload limit after ${MAX_PNG_RENDER_ATTEMPTS} attempts`);
          }

          const nextScale = nextScaleAfterOversize(scale, baseViewport, png.data.length);
          if (nextScale === undefined) {
            throw new Error(`PDF page ${pageNumber} could not be reduced below the image upload limit`);
          }
          scale = nextScale;
        }
        // The loop always assigns on its first iteration, but retain a guard
        // for TypeScript and for any future change to the retry bound.
        if (!png) throw new Error(`PDF page ${pageNumber} could not be rendered`);

        images.push({ mediaType: "image/png", data: png.data, previewUrl: png.previewUrl });
        onProgress?.({ completed: pageNumber, total: pagesToRender });
      } catch (error) {
        pageError = error;
        throw error;
      } finally {
        const pageCleanupError = cleanupPage(page);
        // A rendering failure is the actionable error. Avoid hiding it behind
        // cleanup failures, while still surfacing cleanup failures on success.
        // eslint-disable-next-line no-unsafe-finally -- pageError 守卫保证不掩盖渲染错误
        if (pageError === undefined && pageCleanupError !== undefined) throw pageCleanupError;
      }
    }

    return { images, totalPages, truncated };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupError = await cleanupDocument(document, loadingTask);
    // Preserve the original parsing/rendering error if there was one.
    // eslint-disable-next-line no-unsafe-finally -- operationError 守卫保证不掩盖解析/渲染错误
    if (operationError === undefined && cleanupError !== undefined) throw cleanupError;
  }
}
