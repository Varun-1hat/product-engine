/**
 * ===========================================================================
 * TEMPLATE — copy this file to test a new adapter.
 * ===========================================================================
 *
 * Copy to `src/adapters/<category>/<provider>.test.ts`. Picked up by
 * `npx vitest run` via the `src/**\/*.test.ts` glob in vitest.config.ts.
 *
 * This suite runs for real in CI, so the template it demonstrates is proven to
 * work rather than merely described.
 *
 * ---------------------------------------------------------------------------
 * WHAT TO TEST (and what not to)
 * ---------------------------------------------------------------------------
 * The environment is `node` with no DOM and no network. So test the part of an
 * adapter that is deterministic and cheap — which is also the part that
 * actually causes bugs:
 *
 *   capabilities()  — the declared shape. Cheap, and it guards the fields the
 *                     routing rule and setup UI read (supports_end_frame,
 *                     async, billing_unit).
 *   validate()      — one test per violation, one per warning. This is the
 *                     highest-value surface: it is what stops a paid call.
 *   estimate()      — the returned units AND that no provider call happened.
 *   generate()      — with the SDK or `fetch` mocked at the module boundary.
 *                     Assert the units/unit_type contract and that the result
 *                     was persisted; do not assert on provider internals.
 *
 * Do NOT hit a real provider, and do not test $ amounts anywhere — adapters
 * never price anything (that is src/lib/cost/engine.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageClient } from "@/src/lib/storage";
import { createTemplateAdapter, templateBillableDurationS } from "./adapter";

/**
 * Recording fake instead of a mock library: it keeps assertions about "what
 * got uploaded where" readable, and it is the same helper shape used in
 * src/adapters/image/nano_banana.test.ts and heygen.test.ts.
 */
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

/**
 * `fetch` is global here, so stub the global. For an SDK-based adapter
 * (@google/genai, @anthropic-ai/sdk) mock the module instead, at the top of
 * the file and BEFORE importing the adapter — see nano_banana.test.ts, whose
 * mock must use a real `function` (not an arrow) so `new GoogleGenAI()` works.
 */
function stubFetchJson(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const VALID_INPUT = {
  client_id: "client-1",
  reel_id: "reel-1",
  asset_id: "asset-1",
  prompt: "slow dolly-in on a matte-black espresso machine",
  aspect_ratio: "9:16",
  resolution: "1080p",
  duration_s: 6,
  provider_key: "fake-key",
  idempotency_key: "idem-1",
  start_image: { base64: "ZmFrZQ==", mime_type: "image/png" },
};

describe("createTemplateAdapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("capabilities() reports the shape the routing rule and setup UI read", () => {
    const caps = createTemplateAdapter({ storage: fakeStorage() }).capabilities();
    expect(caps.async).toBe(true);
    expect(caps.billing_unit).toBe("second");
    expect(caps.supports_end_frame).toBe(false);
    expect(caps.supported_aspect_ratios).toEqual(expect.arrayContaining(["9:16", "16:9"]));
  });

  it("validate() requires a prompt", () => {
    const adapter = createTemplateAdapter({ storage: fakeStorage() });
    expect(adapter.validate({}).ok).toBe(false);
  });

  it("validate() rejects an unsupported aspect ratio", () => {
    const adapter = createTemplateAdapter({ storage: fakeStorage() });
    const result = adapter.validate({ prompt: "a shot", aspect_ratio: "21:9", resolution: "1080p" });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/aspect_ratio/);
  });

  it("validate() warns (but does not block) when an end frame is supplied to a start-frame-only model", () => {
    const adapter = createTemplateAdapter({ storage: fakeStorage() });
    const result = adapter.validate({
      prompt: "a shot",
      aspect_ratio: "9:16",
      resolution: "1080p",
      end_image: { base64: "ZmFrZQ==" },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/last-frame/i);
  });

  it("estimate() bills the model's produced duration, not the requested one — with no provider call", () => {
    const fetchMock = stubFetchJson({});
    const adapter = createTemplateAdapter({ storage: fakeStorage() });

    // 6s requested -> the 6s option; 5s requested -> rounded up to 6s, because
    // the provider charges for what it generates.
    expect(adapter.estimate({ aspect_ratio: "9:16", resolution: "1080p", duration_s: 6 })).toEqual({
      units: 6,
      unit_type: "second",
      variant: undefined,
    });
    expect(templateBillableDurationS(5)).toBe(6);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generate() returns pending + a provider_job_id for an async provider", async () => {
    const fetchMock = stubFetchJson({ job_id: "remote-job-9" });
    const adapter = createTemplateAdapter({ storage: fakeStorage() });

    const result = await adapter.generate(VALID_INPUT);

    expect(result.status).toBe("pending");
    expect(result.provider_job_id).toBe("remote-job-9");
    expect(result.units).toBe(6);
    expect(result.unit_type).toBe("second");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("generate() surfaces the provider's error body, not just a status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: async () => "prompt too long",
      })
    );
    const adapter = createTemplateAdapter({ storage: fakeStorage() });

    await expect(adapter.generate(VALID_INPUT)).rejects.toThrow(/422.*prompt too long/s);
  });

  it("poll() persists the finished result and reports succeeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // 1st call: the status check.
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ status: "completed", output_url: "https://cdn.example/out.mp4" }),
        })
        // 2nd call: the download.
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => new ArrayBuffer(16),
        })
    );
    const storage = fakeStorage();
    const adapter = createTemplateAdapter({ storage });

    const result = await adapter.poll!("remote-job-9", "fake-key");

    expect(result.status).toBe("succeeded");
    // Keyed on provider + job id, because poll() has no client/reel context.
    expect(result.asset?.storage_path).toBe("_provider_results/example_provider/remote-job-9.mp4");
    expect(storage.uploads).toHaveLength(1);
  });

  it("poll() stays pending while the provider is still working", async () => {
    stubFetchJson({ status: "processing" });
    const adapter = createTemplateAdapter({ storage: fakeStorage() });

    const result = await adapter.poll!("remote-job-9", "fake-key");
    expect(result.status).toBe("pending");
  });

  it("parseWebhook() is synchronous and passes the URL through for the route to persist", () => {
    const adapter = createTemplateAdapter({ storage: fakeStorage() });

    const parsed = adapter.parseWebhook!({ id: "remote-job-9", state: "completed", url: "https://cdn.example/out.mp4" });

    expect(parsed.provider_job_id).toBe("remote-job-9");
    expect(parsed.status).toBe("succeeded");
    expect(parsed.asset?.url).toBe("https://cdn.example/out.mp4");
    // It cannot upload — it has no async boundary to do I/O across.
    expect(parsed.asset?.storage_path).toBeUndefined();
  });
});
