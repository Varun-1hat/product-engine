/**
 * src/lib/reviewAction.ts — the shared 7-way review-action dispatcher used
 * by every app/api/reels/[reelId]/{image,clip,outro}/review/route.ts (spec
 * §6 ReviewHooks). Pure: dispatchReviewAction() takes a ReviewHooks object
 * and a parsed action body, so this is testable with a fake ReviewHooks
 * spy — no Supabase, no HTTP, no Next request machinery needed. Per
 * .pipeline/changes.md "What the Tester should focus on" #7.
 */
import { describe, expect, it, vi } from "vitest";
import { dispatchReviewAction, reviewActionSchema } from "./reviewAction";
import type { ReviewHooks } from "@/src/stages/types";

function fakeHooks(overrides: Partial<ReviewHooks> = {}): ReviewHooks {
  return {
    redoPrompt: vi.fn().mockResolvedValue({ id: "pv-redo" }),
    editPrompt: vi.fn().mockResolvedValue({ id: "pv-edit" }),
    redoAsset: vi.fn().mockResolvedValue({ job: { id: "job-1" } }),
    revertPrompt: vi.fn().mockResolvedValue(undefined),
    revertAsset: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue("https://signed.example/asset.mp4"),
    history: vi.fn().mockResolvedValue([{ id: "v1" }, { id: "v2" }]),
    ...overrides,
  };
}

describe("reviewActionSchema", () => {
  it("accepts a minimal redoPrompt body", () => {
    const parsed = reviewActionSchema.safeParse({ action: "redoPrompt", promptId: "123e4567-e89b-12d3-a456-426614174000" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an action outside the known 7-way set", () => {
    const parsed = reviewActionSchema.safeParse({ action: "deleteEverything" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-UUID promptId/assetId (defends the DB lookup, not just presence)", () => {
    const parsed = reviewActionSchema.safeParse({ action: "redoPrompt", promptId: "not-a-uuid" });
    expect(parsed.success).toBe(false);
  });
});

describe("dispatchReviewAction — the 7-way switch", () => {
  const promptId = "123e4567-e89b-12d3-a456-426614174000";
  const assetId = "223e4567-e89b-12d3-a456-426614174000";
  const assetVersionId = "323e4567-e89b-12d3-a456-426614174000";

  it("redoPrompt calls hooks.redoPrompt with the given promptId and returns its result", async () => {
    const hooks = fakeHooks();
    const result = await dispatchReviewAction(hooks, { action: "redoPrompt", promptId });
    expect(hooks.redoPrompt).toHaveBeenCalledWith(promptId);
    expect(result).toEqual({ id: "pv-redo" });
  });

  it("redoPrompt without a promptId throws before touching hooks", async () => {
    const hooks = fakeHooks();
    await expect(dispatchReviewAction(hooks, { action: "redoPrompt" })).rejects.toThrow(/promptId is required/);
    expect(hooks.redoPrompt).not.toHaveBeenCalled();
  });

  it("editPrompt forwards promptId, text and refs", async () => {
    const hooks = fakeHooks();
    await dispatchReviewAction(hooks, { action: "editPrompt", promptId, text: "a new prompt", refs: ["a.png"] });
    expect(hooks.editPrompt).toHaveBeenCalledWith(promptId, "a new prompt", ["a.png"]);
  });

  it("editPrompt without text throws (an empty string IS valid input, only undefined is rejected)", async () => {
    const hooks = fakeHooks();
    await expect(dispatchReviewAction(hooks, { action: "editPrompt", promptId })).rejects.toThrow(/text are required/);

    // An explicit empty string is a legitimate edit (clearing the prompt) and must go through.
    await dispatchReviewAction(hooks, { action: "editPrompt", promptId, text: "" });
    expect(hooks.editPrompt).toHaveBeenCalledWith(promptId, "", undefined);
  });

  it("redoAsset calls hooks.redoAsset with the given assetId", async () => {
    const hooks = fakeHooks();
    const result = await dispatchReviewAction(hooks, { action: "redoAsset", assetId });
    expect(hooks.redoAsset).toHaveBeenCalledWith(assetId);
    expect(result).toEqual({ job: { id: "job-1" } });
  });

  it("redoAsset without an assetId throws", async () => {
    const hooks = fakeHooks();
    await expect(dispatchReviewAction(hooks, { action: "redoAsset" })).rejects.toThrow(/assetId is required/);
  });

  it("revertPrompt calls hooks.revertPrompt(promptId, versionNo) and returns {ok:true}", async () => {
    const hooks = fakeHooks();
    const result = await dispatchReviewAction(hooks, { action: "revertPrompt", promptId, versionNo: 2 });
    expect(hooks.revertPrompt).toHaveBeenCalledWith(promptId, 2);
    expect(result).toEqual({ ok: true });
  });

  it("revertPrompt requires both promptId AND versionNo (versionNo=0 must still count as provided)", async () => {
    const hooks = fakeHooks();
    await expect(dispatchReviewAction(hooks, { action: "revertPrompt", promptId })).rejects.toThrow(/versionNo are required/);
    // version_no starts at 1 in practice, but the dispatcher's own guard uses
    // `=== undefined`, not truthiness — 0 must not be treated as "missing".
    await dispatchReviewAction(hooks, { action: "revertPrompt", promptId, versionNo: 0 });
    expect(hooks.revertPrompt).toHaveBeenCalledWith(promptId, 0);
  });

  it("revertAsset calls hooks.revertAsset(assetId, versionNo) and returns {ok:true}", async () => {
    const hooks = fakeHooks();
    const result = await dispatchReviewAction(hooks, { action: "revertAsset", assetId, versionNo: 3 });
    expect(hooks.revertAsset).toHaveBeenCalledWith(assetId, 3);
    expect(result).toEqual({ ok: true });
  });

  it("download calls hooks.download(assetVersionId) and wraps the result in {url}", async () => {
    const hooks = fakeHooks();
    const result = await dispatchReviewAction(hooks, { action: "download", assetVersionId });
    expect(hooks.download).toHaveBeenCalledWith(assetVersionId);
    expect(result).toEqual({ url: "https://signed.example/asset.mp4" });
  });

  it("download without an assetVersionId throws (an assetId alone is not enough — download targets a specific version)", async () => {
    const hooks = fakeHooks();
    await expect(dispatchReviewAction(hooks, { action: "download", assetId })).rejects.toThrow(/assetVersionId is required/);
  });

  it("history forwards whichever of promptId/assetId was given and wraps the result in {history}", async () => {
    const hooks = fakeHooks();
    const result = await dispatchReviewAction(hooks, { action: "history", assetId });
    expect(hooks.history).toHaveBeenCalledWith({ promptId: undefined, assetId });
    expect(result).toEqual({ history: [{ id: "v1" }, { id: "v2" }] });
  });

  it("history with neither promptId nor assetId still dispatches (hooks.history decides what that means)", async () => {
    const hooks = fakeHooks();
    await dispatchReviewAction(hooks, { action: "history" });
    expect(hooks.history).toHaveBeenCalledWith({ promptId: undefined, assetId: undefined });
  });
});
