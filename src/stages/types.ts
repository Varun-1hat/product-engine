/**
 * Standard stage module scaffold (spec §6). src/stages/image is the
 * reference implementation for two-granularity review (prompt level +
 * asset level); src/stages/clip and src/stages/outro copy it. Fixed stage
 * order: reel_setup -> scene -> image -> clip -> trim -> outro -> music ->
 * assembly (brief §2) — which scenes/clip-types are included varies by
 * config, never the order.
 */
import type { ZodType } from "zod";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { CostEngine, EstimateResult } from "@/src/lib/cost/engine";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { SkillRegistry } from "@/src/skills/types";
import type { JobQueue, PublicJob } from "@/src/lib/jobs/queue";
import type { StorageClient } from "@/src/lib/storage";
import type { KeyResolver } from "@/src/lib/crypto/vault";
import type { StageId } from "@/src/lib/db/enums";
import type { AssetVersion, PromptVersion } from "@/src/lib/db/types";

export interface StageContext {
  reelId: string;
  clientId: string;
  supa: ServiceClient;
  costEngine: CostEngine;
  adapters: AdapterRegistry;
  skills: SkillRegistry;
  jobs: JobQueue;
  storage: StorageClient;
  keys: KeyResolver;
}

export interface ReviewHooks {
  redoPrompt(promptId: string): Promise<PromptVersion>;
  editPrompt(promptId: string, text: string, refs?: string[]): Promise<PromptVersion>;
  /** `job`, when present, is a redacted PublicJob (BLOCK-2) — never the raw Job row (callback_token/payload). */
  redoAsset(assetId: string): Promise<{ job?: PublicJob; version?: AssetVersion }>;
  /**
   * Appends a user-uploaded file (already in Storage) as a new `uploaded`
   * version of this asset — an override that skips a paid generation while
   * keeping every generated version revertable. Optional: stages whose
   * assets aren't user-supplyable simply don't implement it.
   */
  uploadAsset?(assetId: string, storagePath: string): Promise<AssetVersion>;
  /**
   * Same, for a slot that hasn't been generated yet — creates the asset and
   * its first version from the upload, so the initial generation can be
   * skipped too. `target` locates the slot the stage's own way (a scene +
   * start/end role for images, a scene for clips, nothing for the outro).
   */
  uploadNewAsset?(target: { sceneId?: string; role?: "start" | "end" }, storagePath: string): Promise<AssetVersion>;
  /**
   * Whether this asset is used in the final render, without touching its
   * versions. Only clip audio is optional in that way today (src/lib/clipAudio.ts);
   * every other slot is used unconditionally, so they don't implement it.
   */
  setAudioEnabled?(assetId: string, enabled: boolean): Promise<void>;
  revertPrompt(promptId: string, versionNo: number): Promise<void>;
  revertAsset(assetId: string, versionNo: number): Promise<void>;
  download(assetVersionId: string): Promise<string>;
  history(target: { promptId?: string; assetId?: string }): Promise<Array<PromptVersion | AssetVersion>>;
}

/** `estimate()`'s return shape is exactly the cost engine's EstimateResult (§4). */
export type CostEstimate = EstimateResult;

/** Resumable rehydrate snapshot returned by `load()` (brief §10.15 — reel resumability). */
export interface StageState {
  stage: StageId;
  data: unknown;
}

export const STAGE_ORDER: StageId[] = [
  "reel_setup",
  "scene",
  "image",
  "clip",
  "trim",
  "outro",
  "music",
  "assembly",
];

export function nextStage(current: StageId): StageId {
  const idx = STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return current;
  return STAGE_ORDER[idx + 1];
}

export interface StageModule<In, Out> {
  id: StageId;
  inputSchema: ZodType<In>;
  load(ctx: StageContext): Promise<StageState>;
  process(input: In, ctx: StageContext): Promise<Out>;
  estimate?(input: In, ctx: StageContext): Promise<CostEstimate>;
  review?: ReviewHooks;
  advance(ctx: StageContext): Promise<StageId>;
}
