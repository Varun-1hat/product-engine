import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeygenAdapter, pullAvatarLooks } from "./heygen";
import type { StorageClient } from "@/src/lib/storage";

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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
    arrayBuffer: async () => new TextEncoder().encode("fake-bytes").buffer,
  } as unknown as Response;
}

describe("createHeygenAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("capabilities(): flat per-video billing, 1-3 avatars, 4-15s", () => {
    const adapter = createHeygenAdapter({ storage: fakeStorage() });
    const caps = adapter.capabilities();
    expect(caps.billing_unit).toBe("video");
    expect(caps.min_avatar_ids).toBe(1);
    expect(caps.max_avatar_ids).toBe(3);
    expect(caps.min_duration_s).toBe(4);
    expect(caps.max_duration_s).toBe(15);
  });

  it("validate() enforces avatar_ids length 1-3", () => {
    const adapter = createHeygenAdapter({ storage: fakeStorage() });

    const none = adapter.validate({
      prompt: "x",
      avatar_ids: [],
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration_s: 8,
    });
    expect(none.ok).toBe(false);

    const four = adapter.validate({
      prompt: "x",
      avatar_ids: ["a", "b", "c", "d"],
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration_s: 8,
    });
    expect(four.ok).toBe(false);

    const two = adapter.validate({
      prompt: "x",
      avatar_ids: ["a", "b"],
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration_s: 8,
    });
    expect(two.ok).toBe(true);
  });

  it("validate() enforces the combined reference budget (<=3 videos, <=9 images)", () => {
    const adapter = createHeygenAdapter({ storage: fakeStorage() });
    const tooManyImages = Array.from({ length: 10 }, () => ({ base64: "x", mime_type: "image/png" }));
    const result = adapter.validate({
      prompt: "x",
      avatar_ids: ["a"],
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration_s: 8,
      references: tooManyImages,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/reference images/);
  });

  // V2 Phase 0 item 9 (.pipeline/spec.md): HeyGen's actual API enforces a
  // COMBINED "video-like" slot budget — avatar looks occupy the same budget
  // as reference videos. Before this fix, avatar_ids.length and videoRefCount
  // were only ever checked independently, so e.g. 2 avatars + 2 reference
  // videos (4 total "video-like" slots > max_reference_videos=3) was
  // incorrectly allowed. src/lib/jobs/**-adjacent, flagged explicitly in
  // .pipeline/changes.md as needing new test coverage since neither of the
  // two tests above exercises avatar_ids and video references together.
  describe("validate() — combined avatar + reference-video budget (max_reference_videos=3)", () => {
    const videoRefs = (n: number) => Array.from({ length: n }, () => ({ base64: "x", mime_type: "video/mp4" }));

    it("rejects 2 avatars + 2 reference videos (sum=4 > 3) even though each is within its own standalone limit", () => {
      const adapter = createHeygenAdapter({ storage: fakeStorage() });
      const result = adapter.validate({
        prompt: "x",
        avatar_ids: ["a", "b"], // within [min_avatar_ids=1, max_avatar_ids=3] alone
        aspect_ratio: "9:16",
        resolution: "1080p",
        duration_s: 8,
        references: videoRefs(2), // within max_reference_videos=3 alone
      });
      expect(result.ok).toBe(false);
      expect(result.violations.join(" ")).toMatch(/combined video-slot budget/);
      expect(result.violations.join(" ")).toMatch(/2 \+ 2 = 4/);
    });

    it("still separately reports the standalone avatar_ids[1,3] violation when both checks fail at once (3 avatars + 3 videos = 6 > 3)", () => {
      const adapter = createHeygenAdapter({ storage: fakeStorage() });
      const result = adapter.validate({
        prompt: "x",
        avatar_ids: ["a", "b", "c"], // within [1,3] alone — no standalone avatar_ids violation
        aspect_ratio: "9:16",
        resolution: "1080p",
        duration_s: 8,
        references: videoRefs(3), // within max_reference_videos=3 alone
      });
      expect(result.ok).toBe(false);
      // Exactly the new combined-budget violation — the standalone checks
      // (avatar_ids length, videoRefCount alone) both individually pass.
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatch(/combined video-slot budget/);
    });

    it("allows 1 avatar + 2 reference videos (sum=3, exactly at the combined budget, not exceeding it)", () => {
      const adapter = createHeygenAdapter({ storage: fakeStorage() });
      const result = adapter.validate({
        prompt: "x",
        avatar_ids: ["a"],
        aspect_ratio: "9:16",
        resolution: "1080p",
        duration_s: 8,
        references: videoRefs(2),
      });
      expect(result.ok).toBe(true);
    });

    it("the pre-existing standalone avatar_ids[1,3] check still fires independently of the combined budget (4 avatars, 0 references)", () => {
      const adapter = createHeygenAdapter({ storage: fakeStorage() });
      const result = adapter.validate({
        prompt: "x",
        avatar_ids: ["a", "b", "c", "d"],
        aspect_ratio: "9:16",
        resolution: "1080p",
        duration_s: 8,
      });
      expect(result.ok).toBe(false);
      expect(result.violations.join(" ")).toMatch(/avatar_ids length 4 must be within \[1, 3\]/);
    });
  });

  it("validate() enforces the 4-15s duration range", () => {
    const adapter = createHeygenAdapter({ storage: fakeStorage() });
    expect(
      adapter.validate({ prompt: "x", avatar_ids: ["a"], aspect_ratio: "9:16", resolution: "1080p", duration_s: 2 }).ok
    ).toBe(false);
    expect(
      adapter.validate({ prompt: "x", avatar_ids: ["a"], aspect_ratio: "9:16", resolution: "1080p", duration_s: 20 })
        .ok
    ).toBe(false);
    expect(
      adapter.validate({ prompt: "x", avatar_ids: ["a"], aspect_ratio: "9:16", resolution: "1080p", duration_s: 8 }).ok
    ).toBe(true);
  });

  it("estimate() is ALWAYS flat 1 video regardless of duration/resolution (R3)", () => {
    const adapter = createHeygenAdapter({ storage: fakeStorage() });
    expect(adapter.estimate({ aspect_ratio: "9:16", resolution: "1080p", duration_s: 15 })).toEqual({
      units: 1,
      unit_type: "video",
    });
    expect(adapter.estimate({ aspect_ratio: "1:1", resolution: "720p", duration_s: 4 })).toEqual({
      units: 1,
      unit_type: "video",
    });
  });

  it("parseWebhook() maps avatar_video.success to a succeeded result with a passthrough asset url (pure, no I/O)", () => {
    const adapter = createHeygenAdapter({ storage: fakeStorage() });
    const result = adapter.parseWebhook!({
      event: "avatar_video.success",
      video_id: "vid_123",
      video_url: "https://cdn.heygen.example/vid_123.mp4",
    });
    expect(result.status).toBe("succeeded");
    expect(result.provider_job_id).toBe("vid_123");
    expect(result.asset?.url).toBe("https://cdn.heygen.example/vid_123.mp4");
    expect(result.units).toBe(1);
    expect(result.unit_type).toBe("video");
    expect(result.billed).toBe(true);
  });

  it("parseWebhook() maps avatar_video.fail to a failed result", () => {
    const adapter = createHeygenAdapter({ storage: fakeStorage() });
    const result = adapter.parseWebhook!({ event: "avatar_video.fail", video_id: "vid_456" });
    expect(result.status).toBe("failed");
    expect(result.provider_job_id).toBe("vid_456");
    expect(result.billed).toBe(false);
  });

  it("generate() posts to /v3/videos and returns the video_id as provider_job_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ video_id: "vid_789" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHeygenAdapter({ storage: fakeStorage() });
    const result = await adapter.generate({
      client_id: "c1",
      reel_id: "r1",
      prompt: "an avatar presenting a bottle",
      avatar_ids: ["look-1"],
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration_s: 8,
      provider_key: "heygen-key",
      idempotency_key: "idem-1",
      callback_url: "https://app.example/api/webhooks/heygen?token=abc",
    });

    expect(result.status).toBe("pending");
    expect(result.provider_job_id).toBe("vid_789");
    expect(result.units).toBe(1);
    expect(result.unit_type).toBe("video");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toContain("/v3/videos");
    expect(init.headers["x-api-key"]).toBe("heygen-key");
    const body = JSON.parse(init.body);
    expect(body.type).toBe("cinematic_avatar");
    expect(body.avatar_id).toEqual(["look-1"]);
    expect(body.callback_url).toContain("token=abc");
  });

  it("poll() downloads and uploads once the video is completed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "completed", video_url: "https://cdn.heygen.example/x.mp4" }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const storage = fakeStorage();
    const adapter = createHeygenAdapter({ storage });
    const result = await adapter.poll!("vid_789", "heygen-key");

    expect(result.status).toBe("succeeded");
    expect(result.units).toBe(1);
    expect(storage.uploads).toHaveLength(1);
  });

  it("poll() reports pending while still processing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "processing" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHeygenAdapter({ storage: fakeStorage() });
    const result = await adapter.poll!("vid_789", "heygen-key");
    expect(result.status).toBe("pending");
  });
});

describe("pullAvatarLooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a plausible { data: [...] } response shape into HeyGenLook[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { id: "look_1", name: "Alex", preview_image_url: "https://x/1.png", preview_video_url: "https://x/1.mp4" },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const looks = await pullAvatarLooks("heygen-key");
    expect(looks).toEqual([
      {
        heygen_look_id: "look_1",
        name: "Alex",
        preview_image_url: "https://x/1.png",
        preview_video_url: "https://x/1.mp4",
        raw: expect.any(Object),
      },
    ]);
  });
});
