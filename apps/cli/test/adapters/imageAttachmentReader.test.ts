import { describe, expect, it, vi } from "vitest";
import {
  createImageAttachmentReader,
  type ImageAttachmentEnvironment,
} from "../../src/adapters/imageAttachmentReader";
import { MAX_IMAGE_BYTES } from "../../src/image/attachment";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function createEnvironment(
  overrides: Partial<ImageAttachmentEnvironment> = {},
): ImageAttachmentEnvironment {
  return {
    platform: "win32",
    run: vi.fn(async () => ({ code: 0, stdout: Buffer.alloc(0) })),
    readFile: vi.fn(async () => PNG),
    removeFile: vi.fn(async () => {}),
    tempPath: () => "C:\\temp\\answra-clipboard.png",
    ...overrides,
  };
}

describe("image attachment reader", () => {
  it("reads a Windows clipboard image through a temporary PNG and cleans it up", async () => {
    const environment = createEnvironment();
    const reader = createImageAttachmentReader(environment);

    await expect(reader.readClipboard()).resolves.toEqual([
      {
        name: "clipboard.png",
        dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
      },
    ]);
    expect(environment.run).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-STA", "-Command"]),
    );
    expect(environment.removeFile).toHaveBeenCalledWith("C:\\temp\\answra-clipboard.png");
  });

  it("returns no attachment when the clipboard has no image", async () => {
    const environment = createEnvironment({
      run: vi.fn(async () => ({ code: 1, stdout: Buffer.alloc(0) })),
    });
    const reader = createImageAttachmentReader(environment);

    await expect(reader.readClipboard()).resolves.toEqual([]);
    expect(environment.removeFile).toHaveBeenCalled();
  });

  it("falls back to the next Linux clipboard command", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, stdout: Buffer.alloc(0) })
      .mockResolvedValueOnce({ code: 0, stdout: PNG });
    const environment = createEnvironment({ platform: "linux", run });
    const reader = createImageAttachmentReader(environment);

    await expect(reader.readClipboard()).resolves.toEqual([
      {
        name: "clipboard.png",
        dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
      },
    ]);
    expect(run).toHaveBeenNthCalledWith(1, "wl-paste", ["--type", "image/png"]);
    expect(run).toHaveBeenNthCalledWith(2, "xclip", [
      "-selection",
      "clipboard",
      "-t",
      "image/png",
      "-o",
    ]);
  });

  it("reads an image path and detects its media type from bytes", async () => {
    const environment = createEnvironment({
      readFile: vi.fn(async () => JPEG),
    });
    const reader = createImageAttachmentReader(environment);

    await expect(reader.readPath("C:\\shots\\capture.jpg")).resolves.toEqual({
      name: "capture.jpg",
      dataUrl: `data:image/jpeg;base64,${JPEG.toString("base64")}`,
    });
  });

  it("rejects oversized images instead of silently dropping them", async () => {
    const environment = createEnvironment({
      readFile: vi.fn(async () => Buffer.alloc(MAX_IMAGE_BYTES + 1)),
    });
    const reader = createImageAttachmentReader(environment);

    await expect(reader.readPath("C:\\shots\\huge.png")).rejects.toThrowError(
      "单张图片不能超过 8 MB",
    );
  });

  it("rejects unsupported image bytes", async () => {
    const environment = createEnvironment({
      readFile: vi.fn(async () => Buffer.from("BM")),
    });
    const reader = createImageAttachmentReader(environment);

    await expect(reader.readPath("C:\\shots\\capture.bmp")).rejects.toThrowError("图片格式仅支持");
  });

  it("does not leak a temporary file when reading it fails", async () => {
    const environment = createEnvironment({
      readFile: vi.fn(async () => {
        throw new Error("missing");
      }),
    });
    const reader = createImageAttachmentReader(environment);

    await expect(reader.readClipboard()).resolves.toEqual([]);
    expect(environment.removeFile).toHaveBeenCalledWith("C:\\temp\\answra-clipboard.png");
  });
});
