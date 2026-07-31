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
import type { LlmUsageSink } from "@/src/skills/llm";
import { DEFAULT_ORCHESTRATOR_MODEL, providerForOrchestratorModel } from "./orchestratorModels";
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
  const costEngine = createCostEngine(supa);

  // The orchestrating LLM is a per-reel Stage 2 choice; null = the built-in
  // default (callLlmJson resolves it).
  const { data: cfg, error: cfgError } = await supa
    .from("reel_config")
    .select("orchestrator_model")
    .eq("reel_id", reelId)
    .maybeSingle();
  if (cfgError) throw new Error(`reel_config lookup failed: ${cfgError.message}`);
  const orchestratorModel = (cfg as { orchestrator_model: string | null } | null)?.orchestrator_model ?? undefined;

  // Every runtime-skill LLM call (prompt generation + orchestration) is
  // billed to this reel, as two cost_log rows — input and output tokens are
  // priced differently, and cost_log carries a single units/unit_type pair.
  // Logged against the reel's current stage; `adapter` records which model
  // actually ran, and `provider` follows from it (anthropic vs gemini).
  // Failures here are swallowed by callLlmJson's onUsage guard so bookkeeping
  // can never break a generation.
  const logLlmUsage: LlmUsageSink = async (usage) => {
    const common = {
      reel_id: reelId,
      client_id: reel.client_id,
      stage: reel.current_stage,
      provider: providerForOrchestratorModel(usage.model),
      adapter: usage.model,
      call_type: "generate" as const,
      call_status: "success" as const,
    };
    await costEngine.log({ ...common, units: usage.input_tokens, unit_type: "input_token" });
    await costEngine.log({ ...common, units: usage.output_tokens, unit_type: "output_token" });
  };

  // Per-client orchestrator key (Config > Keys), so each client's LLM spend
  // lands on their own account. Not configured => the agency-level env key.
  const keys = createKeyResolver(supa);
  const orchestratorProvider = providerForOrchestratorModel(
    orchestratorModel ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ORCHESTRATOR_MODEL
  );
  let orchestratorKey: string | undefined;
  try {
    orchestratorKey = await keys.forProvider(reel.client_id, orchestratorProvider);
  } catch {
    orchestratorKey = undefined;
  }

  const [adapters, skills] = await Promise.all([
    getDefaultAdapterRegistry(),
    createSkillRegistry(logLlmUsage, orchestratorModel, orchestratorKey),
  ]);

  return {
    reelId,
    clientId: reel.client_id,
    supa,
    costEngine,
    adapters,
    skills,
    jobs: createJobQueue(supa),
    storage: createStorageClient(supa),
    keys,
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
