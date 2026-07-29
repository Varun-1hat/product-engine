/**
 * src/adapters/config.ts had zero direct test coverage. Focus: V2 Phase 0
 * item 8 / N7 (.pipeline/spec.md) — HIGGSFIELD_CONFIG.baseUrl used to
 * default to "https://api.higgsfield.ai/v1", while
 * src/adapters/video_broll/higgsfield.ts separately appends
 * "/v1/generations"/"/v1/generations/{id}" itself, doubling the path
 * ("…/v1/v1/generations"). The fix drops the trailing /v1 from the config
 * default only. See src/adapters/video_broll/higgsfield.test.ts for the
 * integration-level check (the actual fetch() URL generate()/poll() hit).
 *
 * Each test stubs/deletes the relevant env var and restores it afterward
 * (vi.unstubAllEnvs) so this is deterministic regardless of what a
 * developer's local .env/.env.local happens to contain — confirmed
 * empirically that `npx vitest run` does NOT load .env/.env.local into
 * process.env in this repo (no dotenv wiring in vitest.config.ts), but
 * stubbing explicitly here means this test can't ever become order- or
 * environment-dependent even if that changes later.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEYGEN_CONFIG, HIGGSFIELD_CONFIG } from "./config";

describe("HIGGSFIELD_CONFIG.baseUrl (N7 — no trailing /v1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the bare host with NO trailing /v1 when HIGGSFIELD_BASE_URL is unset", () => {
    vi.stubEnv("HIGGSFIELD_BASE_URL", undefined);
    expect(HIGGSFIELD_CONFIG.baseUrl).toBe("https://api.higgsfield.ai");
    expect(HIGGSFIELD_CONFIG.baseUrl.endsWith("/v1")).toBe(false);
  });

  it("still honors an explicit HIGGSFIELD_BASE_URL override (e.g. for testing against a different host)", () => {
    vi.stubEnv("HIGGSFIELD_BASE_URL", "https://staging.higgsfield.example");
    expect(HIGGSFIELD_CONFIG.baseUrl).toBe("https://staging.higgsfield.example");
  });
});

describe("HEYGEN_CONFIG.baseUrl (regression guard — never had the /v1 bug, kept honest for contrast)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to https://api.heygen.com when HEYGEN_BASE_URL is unset", () => {
    vi.stubEnv("HEYGEN_BASE_URL", undefined);
    expect(HEYGEN_CONFIG.baseUrl).toBe("https://api.heygen.com");
  });
});
