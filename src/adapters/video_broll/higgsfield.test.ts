import { afterEach, describe, expect, it, vi } from "vitest";
import { createHiggsfieldAdapter } from "./higgsfield";
import type { StorageClient } from "@/src/lib/storage";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

function fakeStorage(): StorageClient {
  return {
    async upload(_bucket, path) {
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

describe("createHiggsfieldAdapter (wave 2, low confidence — verify docs before real use)", () => {
  it("capabilities(): supports_end_frame=false forces hard_cut routing", () => {
    const adapter = createHiggsfieldAdapter({ storage: fakeStorage() });
    const caps = adapter.capabilities();
    expect(caps.supports_end_frame).toBe(false);
    expect(caps.billing_unit).toBe("credit");
    expect(caps.async).toBe(true);
  });

  it("validate() requires start_image and always carries a low-confidence warning", () => {
    const adapter = createHiggsfieldAdapter({ storage: fakeStorage() });
    const result = adapter.validate({ prompt: "x", aspect_ratio: "9:16", resolution: "720p" });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/start_image/);
    expect(result.warnings.join(" ")).toMatch(/low-confidence/);
  });

  it("validate() warns (does not block) when an end_image is supplied, since it has no confirmed effect", () => {
    const adapter = createHiggsfieldAdapter({ storage: fakeStorage() });
    const result = adapter.validate({
      prompt: "x",
      aspect_ratio: "9:16",
      resolution: "720p",
      start_image: { base64: "abc" },
      end_image: { base64: "def" },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/end-frame/);
  });

  it("estimate() uses duration_s as the unconfirmed credit-units proxy — no provider call", () => {
    const adapter = createHiggsfieldAdapter({ storage: fakeStorage() });
    expect(adapter.estimate({ aspect_ratio: "9:16", resolution: "720p", duration_s: 6 })).toEqual({
      units: 6,
      unit_type: "credit",
    });
  });

  // V2 Phase 0 item 8 / N7 (.pipeline/spec.md): HIGGSFIELD_CONFIG.baseUrl
  // used to default to ".../v1", and this adapter separately appends
  // "/v1/generations" itself — the combination doubled the path segment
  // ("…/v1/v1/generations"). This asserts the ACTUAL fetch() URL generate()
  // hits, which is the integration point that matters (src/adapters/config.test.ts
  // covers the config default in isolation).
  describe("generate() — base-URL doubling regression guard (N7)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it("POSTs to exactly {baseUrl}/v1/generations — no doubled /v1 segment", async () => {
      vi.stubEnv("HIGGSFIELD_BASE_URL", undefined); // force the code default, regardless of local .env
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ generation_id: "gen_1" }));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = createHiggsfieldAdapter({ storage: fakeStorage() });
      await adapter.generate({
        client_id: "c1",
        reel_id: "r1",
        prompt: "a bottle spinning",
        start_image: { base64: "abc", mime_type: "image/png" },
        aspect_ratio: "9:16",
        resolution: "720p",
        duration_s: 6,
        provider_key: "higgsfield-key",
        idempotency_key: "idem-1",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string, unknown];
      expect(url).toBe("https://api.higgsfield.ai/v1/generations");
      expect(url).not.toContain("/v1/v1");
    });
  });
});
