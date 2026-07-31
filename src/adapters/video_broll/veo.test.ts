import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageClient } from "@/src/lib/storage";
import { VEO_CONFIG } from "@/src/adapters/config";

const generateVideosMock = vi.fn();
const getVideosOperationMock = vi.fn();

class FakeGenerateVideosOperation {
  name?: string;
  done?: boolean;
  response?: unknown;
  error?: unknown;
}

vi.mock("@google/genai", () => ({
  // Must be a real `function` (not an arrow fn) so `new GoogleGenAI(...)`
  // in the adapter works — arrow functions cannot be invoked with `new`.
  GoogleGenAI: vi.fn().mockImplementation(function GoogleGenAI() {
    return {
      models: { generateVideos: generateVideosMock },
      operations: { getVideosOperation: getVideosOperationMock },
    };
  }),
  GenerateVideosOperation: FakeGenerateVideosOperation,
}));

const { createVeoAdapter, billableDurationS } = await import("./veo");

function fakeStorage(): StorageClient & { uploads: Array<{ bucket: string; path: string }> } {
  const uploads: Array<{ bucket: string; path: string }> = [];
  return {
    uploads,
    async upload(bucket, path) {
      uploads.push({ bucket, path });
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

describe("billableDurationS", () => {
  it("defaults to 8s when no duration is requested", () => {
    expect(billableDurationS(undefined)).toBe(8);
  });

  it("picks the smallest supported option >= requested", () => {
    expect(billableDurationS(3)).toBe(4);
    expect(billableDurationS(5)).toBe(6);
    expect(billableDurationS(6)).toBe(6);
    expect(billableDurationS(7)).toBe(8);
  });

  it("clamps to 8 when requested exceeds the max", () => {
    expect(billableDurationS(20)).toBe(8);
  });
});

describe("createVeoAdapter", () => {
  beforeEach(() => {
    generateVideosMock.mockReset();
    getVideosOperationMock.mockReset();
  });

  it("capabilities(): supports_end_frame=true, emits_audio=true, per-second billing", () => {
    const adapter = createVeoAdapter({ storage: fakeStorage() });
    const caps = adapter.capabilities();
    expect(caps.supports_end_frame).toBe(true);
    expect(caps.emits_audio).toBe(true);
    expect(caps.billing_unit).toBe("second");
    expect(caps.async).toBe(true);
  });

  it("validate() requires a start_image and rejects an unknown variant", () => {
    const adapter = createVeoAdapter({ storage: fakeStorage() });

    const missingStart = adapter.validate({ prompt: "x", aspect_ratio: "9:16", resolution: "1080p" });
    expect(missingStart.ok).toBe(false);
    expect(missingStart.violations.join(" ")).toMatch(/start_image/);

    const badVariant = adapter.validate({
      prompt: "x",
      aspect_ratio: "9:16",
      resolution: "1080p",
      start_image: { base64: "abc" },
      variant: "ultra",
    });
    expect(badVariant.ok).toBe(false);
    expect(badVariant.violations.join(" ")).toMatch(/variant/);
  });

  it("validate() warns (does not block) when duration_s exceeds the ~8s max", () => {
    const adapter = createVeoAdapter({ storage: fakeStorage() });
    const result = adapter.validate({
      prompt: "x",
      aspect_ratio: "9:16",
      resolution: "1080p",
      start_image: { base64: "abc" },
      duration_s: 20,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("estimate() bills the generated (not trimmed) duration — no provider call", () => {
    const adapter = createVeoAdapter({ storage: fakeStorage() });
    expect(adapter.estimate({ aspect_ratio: "9:16", resolution: "1080p", duration_s: 5, variant: "fast" })).toEqual({
      units: 6,
      unit_type: "second",
      variant: "fast",
    });
    expect(generateVideosMock).not.toHaveBeenCalled();
  });

  it("generate() forces 8s when an end frame or 1080p is requested, and returns the operation name as provider_job_id", async () => {
    generateVideosMock.mockResolvedValue({ name: "operations/abc123", done: false });
    const storage = fakeStorage();
    const adapter = createVeoAdapter({ storage });

    const result = await adapter.generate({
      client_id: "c1",
      reel_id: "r1",
      scene_id: "s1",
      prompt: "a bottle spinning on a table",
      start_image: { base64: "c3RhcnQ=", mime_type: "image/png" },
      end_image: { base64: "ZW5k", mime_type: "image/png" },
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration_s: 3,
      variant: "fast",
      provider_key: "fake-google-key",
      idempotency_key: "idem-veo-1",
    });

    expect(result.status).toBe("pending");
    expect(result.provider_job_id).toBe("operations/abc123");
    // Veo requires 8s whenever lastFrame or 1080p is in play (both here), so
    // the requested 3s is overridden — and we're billed for what it generates.
    expect(result.units).toBe(8);
    expect(result.unit_type).toBe("second");
    expect(result.variant).toBe("fast");

    expect(generateVideosMock).toHaveBeenCalledTimes(1);
    const call = generateVideosMock.mock.calls[0][0];
    expect(call.model).toBe(VEO_CONFIG.models.fast);
    expect(call.config.durationSeconds).toBe(8);
    expect(call.config.lastFrame).toBeTruthy();
  });

  it("generate() rounds duration up via billableDurationS when neither an end frame nor 1080p forces 8s", async () => {
    generateVideosMock.mockResolvedValue({ name: "operations/dur", done: false });
    const adapter = createVeoAdapter({ storage: fakeStorage() });

    const result = await adapter.generate({
      client_id: "c1",
      reel_id: "r1",
      prompt: "a bottle spinning",
      start_image: { base64: "c3RhcnQ=" },
      aspect_ratio: "16:9",
      resolution: "720p",
      duration_s: 3,
      variant: "fast",
      provider_key: "k",
      idempotency_key: "idem-dur",
    });

    expect(result.units).toBe(4); // billableDurationS(3) === 4
    expect(generateVideosMock.mock.calls[0][0].config.durationSeconds).toBe(4);
  });

  it("generate() uses the standard model id for the standard variant", async () => {
    generateVideosMock.mockResolvedValue({ name: "operations/xyz", done: false });
    const adapter = createVeoAdapter({ storage: fakeStorage() });

    await adapter.generate({
      client_id: "c1",
      reel_id: "r1",
      prompt: "a bottle spinning",
      start_image: { base64: "c3RhcnQ=" },
      aspect_ratio: "16:9",
      resolution: "720p",
      variant: "standard",
      provider_key: "k",
      idempotency_key: "idem-2",
    });

    // Asserted against the config rather than a hardcoded id — the claim here
    // is "the standard variant uses the standard-tier model id", not what that
    // id currently happens to be (see VEO_CONFIG.models).
    const call = generateVideosMock.mock.calls[0][0];
    expect(call.model).toBe(VEO_CONFIG.models.standard);
    expect(call.config.lastFrame).toBeUndefined();
  });

  it("poll() downloads+uploads the finished video once the operation is done", async () => {
    getVideosOperationMock.mockResolvedValue({
      name: "operations/abc123",
      done: true,
      response: { generatedVideos: [{ video: { videoBytes: "ZmFrZS12aWRlbw==", mimeType: "video/mp4" } }] },
    });

    const storage = fakeStorage();
    const adapter = createVeoAdapter({ storage });
    const result = await adapter.poll!("operations/abc123", "fake-google-key");

    expect(result.status).toBe("succeeded");
    expect(result.asset?.mime).toBe("video/mp4");
    expect(storage.uploads).toHaveLength(1);
  });

  it("poll() reports pending without uploading anything while the operation is still running", async () => {
    getVideosOperationMock.mockResolvedValue({ name: "operations/abc123", done: false });
    const storage = fakeStorage();
    const adapter = createVeoAdapter({ storage });

    const result = await adapter.poll!("operations/abc123", "fake-google-key");
    expect(result.status).toBe("pending");
    expect(storage.uploads).toHaveLength(0);
  });

  it("poll() throws when the operation completed with no generated video", async () => {
    getVideosOperationMock.mockResolvedValue({ name: "operations/abc123", done: true, response: { generatedVideos: [] } });
    const adapter = createVeoAdapter({ storage: fakeStorage() });
    await expect(adapter.poll!("operations/abc123", "k")).rejects.toThrow(/no generated video/);
  });
});
