/**
 * Composition root for app/api/** route handlers: builds the various
 * stage contexts from the service client + already-implemented src/lib/*
 * factories. Route handlers stay thin (parse request -> build context ->
 * call the stage module) instead of re-deriving this wiring per-route.
 */
import { createServiceClient } from "./supabase/service";
import { createStorageClient } from "./storage";
import { createJobQueue } from "./jobs/queue";
import { createCostEngine } from "./cost/engine";
import { createKeyResolver } from "./crypto/vault";
import { getDefaultAdapterRegistry } from "@/src/adapters/registry";
import { createSkillRegistry } from "@/src/skills/types";
import type { StageContext } from "@/src/stages/types";
import type { ConfigStageContext } from "@/src/stages/config";
import type { ReelSetupStageContext } from "@/src/stages/reel-setup";
import type { Reel } from "./db/types";

export async function getReel(reelId: string): Promise<Reel> {
  const supa = createServiceClient();
  const { data, error } = await supa.from("reels").select("*").eq("id", reelId).single();
  if (error) throw new Error(`reels lookup failed: ${error.message}`);
  return data as Reel;
}

/** Full StageContext for the per-reel stages (scene, image, clip, trim, outro, music, assembly). */
export async function buildStageContext(reelId: string): Promise<StageContext> {
  const supa = createServiceClient();
  const reel = await getReel(reelId);
  const [adapters, skills] = await Promise.all([getDefaultAdapterRegistry(), createSkillRegistry()]);

  return {
    reelId,
    clientId: reel.client_id,
    supa,
    costEngine: createCostEngine(supa),
    adapters,
    skills,
    jobs: createJobQueue(supa),
    storage: createStorageClient(supa),
    keys: createKeyResolver(supa),
  };
}

/** Stage 1 (client-level) context. */
export function buildConfigContext(clientId: string): ConfigStageContext {
  const supa = createServiceClient();
  return {
    clientId,
    supa,
    jobs: createJobQueue(supa),
    storage: createStorageClient(supa),
    keys: createKeyResolver(supa),
  };
}

/** Stage 2 (reel-setup) context — reelId absent when creating a new reel. */
export async function buildReelSetupContext(clientId: string, reelId?: string): Promise<ReelSetupStageContext> {
  const supa = createServiceClient();
  const adapters = await getDefaultAdapterRegistry();
  return { clientId, reelId, supa, adapters };
}
