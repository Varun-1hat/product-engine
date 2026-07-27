import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageClient } from "@/src/lib/storage";

const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  // Must be a real `function` (not an arrow fn) so `new GoogleGenAI(...)`
  // in the adapter works — arrow functions cannot be invoked with `new`.
  GoogleGenAI: vi.fn().mockImplementation(function GoogleGenAI() {
    return { models: { generateContent: generateContentMock } };
  }),
}));

const { createNanoBananaAdapter } = await import("./nano_banana");

function fakeStorage(): StorageClient & { uploads: Array<{ bucket: string; path: string; contentType: string }> } {
  const uploads: Array<{ bucket: string; path: string; contentType: string }> = [];
  return {
    uploads,
    async upload(bucket, path, _data, contentType) {
      uploads.push({ bucket, path, contentType });
      return { path };
    },
    async download() {
      throw new Error("not implemented in fake");
    },
    async signedUrl() {
      return "https://signed.example/fake";
    },
    async remove() {},
  };
}

describe("createNanoBananaAdapter", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it("capabilities() reports the documented shape (sync, per-image billing)", () => {
    const adapter = createNanoBananaAdapter({ storage: fakeStorage() });
    const caps = adapter.capabilities();
    expect(caps.async).toBe(false);
    expect(caps.billing_unit).toBe("image");
    expect(caps.supported_aspect_ratios).toEqual(expect.arrayContaining(["9:16", "1:1", "16:9"]));
  });

  it("validate() rejects an unsupported aspect ratio", () => {
    const adapter = createNanoBananaAdapter({ storage: fakeStorage() });
    const result = adapter.validate({ prompt: "a shot", aspect_ratio: "21:9", resolution: "1080p" });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/aspect_ratio/);
  });

  it("validate() requires a prompt", () => {
    const adapter = createNanoBananaAdapter({ storage: fakeStorage() });
    expect(adapter.validate({}).ok).toBe(false);
  });

  it("validate() enforces the max_reference_images budget", () => {
    const adapter = createNanoBananaAdapter({ storage: fakeStorage() });
    const tooMany = Array.from({ length: 9 }, () => ({ base64: "abc", mime_type: "image/png" }));
    const result = adapter.validate({ prompt: "x", aspect_ratio: "9:16", resolution: "1080p", references: tooMany });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/reference images/);
  });

  it("estimate() is 1 image per call by default (no provider call)", () => {
    const adapter = createNanoBananaAdapter({ storage: fakeStorage() });
    expect(adapter.estimate({ aspect_ratio: "9:16", resolution: "1080p" })).toEqual({
      units: 1,
      unit_type: "image",
    });
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("generate() uploads the returned inline image and reports units=1/unit_type=image", async () => {
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: "ZmFrZS1iYXNlNjQ=", mimeType: "image/png" } }],
          },
        },
      ],
    });

    const storage = fakeStorage();
    const adapter = createNanoBananaAdapter({ storage });

    const result = await adapter.generate({
      client_id: "client-1",
      reel_id: "reel-1",
      asset_id: "asset-1",
      prompt: "a product on a table",
      aspect_ratio: "9:16",
      resolution: "1080p",
      provider_key: "fake-key",
      idempotency_key: "idem-1",
    });

    expect(result.status).toBe("succeeded");
    expect(result.units).toBe(1);
    expect(result.unit_type).toBe("image");
    expect(result.asset?.storage_path).toContain("client-1/reel-1/generated/asset-1/idem-1");
    expect(result.asset?.metadata.aspect).toBe("9:16");
    expect(storage.uploads).toHaveLength(1);
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("generate() throws a clear error when Gemini returns no image part", async () => {
    generateContentMock.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "sorry, no image" }] } }] });
    const adapter = createNanoBananaAdapter({ storage: fakeStorage() });

    await expect(
      adapter.generate({
        client_id: "c",
        reel_id: "r",
        asset_id: "a",
        prompt: "x",
        aspect_ratio: "9:16",
        resolution: "1080p",
        provider_key: "k",
        idempotency_key: "i",
      })
    ).rejects.toThrow(/no image/i);
  });
});
