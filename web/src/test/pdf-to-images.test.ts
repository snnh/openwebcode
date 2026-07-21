import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist", () => pdfjs);
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min.mjs" }));

import { renderPdfToImages } from "../lib/pdf-to-images";

type MockPage = ReturnType<typeof makePage>;

const createdCanvases: HTMLCanvasElement[] = [];
const encodedSizes: Array<[number, number]> = [];
let pngDataUrlForCanvas: (canvas: HTMLCanvasElement) => string;

function makePdfFile(): File {
  return {
    arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
  } as unknown as File;
}

function makePage(marker: string, width = 612, height = 792): {
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale })),
    render: vi.fn(({ canvasContext }: { canvasContext: CanvasRenderingContext2D }) => {
      (canvasContext as unknown as { canvas: HTMLCanvasElement }).canvas.dataset.page = marker;
      return { promise: Promise.resolve(), cancel };
    }),
    cleanup: vi.fn(),
    cancel,
  };
}

function installDocument(pages: MockPage[], totalPages = pages.length): {
  document: { numPages: number; getPage: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  loadingTask: { promise: Promise<unknown>; destroy: ReturnType<typeof vi.fn> };
} {
  const document = {
    numPages: totalPages,
    getPage: vi.fn((pageNumber: number) => Promise.resolve(pages[pageNumber - 1])),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  const loadingTask = {
    promise: Promise.resolve(document),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  pdfjs.getDocument.mockReturnValue(loadingTask);
  return { document, loadingTask };
}

beforeEach(() => {
  pdfjs.getDocument.mockReset();
  createdCanvases.length = 0;
  encodedSizes.length = 0;
  pngDataUrlForCanvas = (canvas) => `data:image/png;base64,${canvas.dataset.page ?? "unknown"}`;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function getContext(this: HTMLCanvasElement) {
    createdCanvases.push(this);
    return { canvas: this } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function toDataURL(this: HTMLCanvasElement) {
    encodedSizes.push([this.width, this.height]);
    return pngDataUrlForCanvas(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderPdfToImages", () => {
  it("renders source pages sequentially, preserving order and reporting progress", async () => {
    const pages = [makePage("page-1"), makePage("page-2"), makePage("page-3")];
    const { document, loadingTask } = installDocument(pages);
    const onProgress = vi.fn();

    const result = await renderPdfToImages(makePdfFile(), { maxPages: 3 }, onProgress);

    expect(result).toEqual({
      images: [
        { mediaType: "image/png", data: "page-1", previewUrl: "data:image/png;base64,page-1" },
        { mediaType: "image/png", data: "page-2", previewUrl: "data:image/png;base64,page-2" },
        { mediaType: "image/png", data: "page-3", previewUrl: "data:image/png;base64,page-3" },
      ],
      totalPages: 3,
      truncated: false,
    });
    expect(document.getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2, 3]);
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { completed: 0, total: 3 },
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
    for (const page of pages) expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(document.destroy).toHaveBeenCalledTimes(1);
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
    expect(createdCanvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it("honors maxPages and reports source-page truncation", async () => {
    const pages = [makePage("page-1"), makePage("page-2"), makePage("not-rendered")];
    const { document } = installDocument(pages, 5);

    const result = await renderPdfToImages(makePdfFile(), { maxPages: 2 });

    expect(result.images.map((image) => image.data)).toEqual(["page-1", "page-2"]);
    expect(result.totalPages).toBe(5);
    expect(result.truncated).toBe(true);
    expect(document.getPage).toHaveBeenCalledTimes(2);
    expect(document.getPage).not.toHaveBeenCalledWith(3);
  });

  it("uses DPI scaling, constrains the longest edge, and reports completion", async () => {
    const page = makePage("scaled", 1440, 720);
    installDocument([page]);
    const onProgress = vi.fn();

    await renderPdfToImages(makePdfFile(), { dpi: 144, maxDimension: 2048 }, onProgress);

    const limitedScale = 2048 / 1440;
    expect(page.getViewport).toHaveBeenNthCalledWith(1, { scale: 1 });
    expect(page.getViewport).toHaveBeenNthCalledWith(2, { scale: limitedScale });
    expect(encodedSizes).toEqual([[2048, 1024]]);
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 1, total: 1 });
  });

  it("rerenders an oversized PNG at a smaller scale before returning it", async () => {
    const page = makePage("downscaled", 2048, 1024);
    installDocument([page]);
    let encodes = 0;
    pngDataUrlForCanvas = () => {
      encodes += 1;
      return encodes === 1
        ? `data:image/png;base64,${"A".repeat(7_000_001)}`
        : "data:image/png;base64,downscaled";
    };

    const result = await renderPdfToImages(makePdfFile());

    expect(page.render).toHaveBeenCalledTimes(2);
    const [firstRender] = page.render.mock.calls[0]!;
    const [secondRender] = page.render.mock.calls[1]!;
    expect(secondRender.viewport.width).toBeLessThan(firstRender.viewport.width);
    expect(secondRender.viewport.height).toBeLessThan(firstRender.viewport.height);
    expect(encodedSizes).toEqual([[2048, 1024], [1843, 921]]);
    expect(result.images[0]?.data).toBe("downscaled");
    expect(result.images[0]?.data.length).toBeLessThanOrEqual(7_000_000);
    expect(createdCanvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it("bounds repeated oversized PNG rerenders", async () => {
    const page = makePage("never-small", 2048, 1024);
    installDocument([page]);
    pngDataUrlForCanvas = () => `data:image/png;base64,${"A".repeat(7_000_001)}`;

    await expect(renderPdfToImages(makePdfFile())).rejects.toThrow(/after 10 attempts/);

    expect(page.render).toHaveBeenCalledTimes(10);
    expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(createdCanvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it("cleans up page, canvas, document, and loading task while preserving a render error", async () => {
    const first = makePage("first");
    const second = makePage("second");
    const renderFailure = new Error("second page failed");
    second.render.mockReturnValue({ promise: Promise.reject(renderFailure), cancel: second.cancel });
    const { document, loadingTask } = installDocument([first, second]);
    document.destroy.mockRejectedValue(new Error("document cleanup failed"));
    loadingTask.destroy.mockRejectedValue(new Error("loading task cleanup failed"));

    await expect(renderPdfToImages(makePdfFile(), { maxPages: 2 })).rejects.toBe(renderFailure);

    expect(first.cleanup).toHaveBeenCalledTimes(1);
    expect(second.cleanup).toHaveBeenCalledTimes(1);
    expect(second.cancel).toHaveBeenCalledTimes(1);
    expect(document.destroy).toHaveBeenCalledTimes(1);
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
    expect(createdCanvases).toHaveLength(2);
    expect(createdCanvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });
});
