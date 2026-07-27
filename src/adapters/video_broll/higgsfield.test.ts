import { describe, expect, it } from "vitest";
import { createHiggsfieldAdapter } from "./higgsfield";
import type { StorageClient } from "@/src/lib/storage";

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
});
