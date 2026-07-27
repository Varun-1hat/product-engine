/**
 * Stage 2 — Reel setup (spec §7 Stage 2).
 *
 * Like Stage 1, this doesn't fit the generic per-reel `StageModule` shape
 * cleanly: it's the stage that *creates* the reel, so `reelId` doesn't
 * exist yet on the create path (only on later edits). Exposes its own
 * appropriately-shaped functions instead.
 *
 * Validation: avatar_enabled=true => avatar_look_id required.
 * broll_provider required if avatar_enabled=false (optional — all-avatar —
 * if avatar is on; any b-roll scene/outro-as-clip without an effective
 * model is blocked later at Stage 4/7 with a "select a b-roll model"
 * prompt, settable retroactively including per-scene override).
 * aspect_ratio/resolution constrained to the intersection of every chosen
 * adapter's capabilities. Cost: none.
 */
import { z } from "zod";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { ValidationResult } from "@/src/adapters/types";
import { ASPECT_RATIOS, PROVIDERS, RESOLUTIONS, VEO_VARIANTS } from "@/src/lib/db/enums";
import type { Reel, ReelConfigRow } from "@/src/lib/db/types";

export interface ReelSetupStageContext {
  clientId: string;
  /** Absent when creating a brand-new reel; present when editing an existing one's setup. */
  reelId?: string;
  supa: ServiceClient;
  adapters: AdapterRegistry;
}

export const reelSetupInputSchema = z.object({
  display_name: z.string().min(1).optional(),
  topic: z.string().min(1),
  total_seconds_target: z.number().positive(),
  avatar_enabled: z.boolean(),
  avatar_look_id: z.string().uuid().optional(),
  broll_provider: z.enum(PROVIDERS).optional(),
  image_provider: z.enum(PROVIDERS).default("nano_banana"),
  veo_variant: z.enum(VEO_VARIANTS).default("fast"),
  outro_provider_override: z.enum(PROVIDERS).optional(),
  aspect_ratio: z.enum(ASPECT_RATIOS),
  resolution: z.enum(RESOLUTIONS),
  output_fps: z.number().int().positive().default(30),
});
export type ReelSetupInput = z.infer<typeof reelSetupInputSchema>;

export interface ReelSetupOutput {
  reel: Reel;
  reel_config: ReelConfigRow;
  validation: ValidationResult;
}

export function validateReelSetup(input: ReelSetupInput, adapters: AdapterRegistry): ValidationResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (input.avatar_enabled && !input.avatar_look_id) {
    violations.push("avatar_look_id is required when avatar_enabled is true");
  }
  if (!input.avatar_enabled && !input.broll_provider) {
    violations.push("broll_provider is required when avatar_enabled is false");
  }
  if (input.avatar_enabled && !input.broll_provider) {
    warnings.push(
      "no b-roll model selected — this will be an all-avatar reel; a b-roll model can still be set later (per-scene override) before Stage 4/5"
    );
  }

  const relevant: Array<{ category: "image" | "video_broll" | "video_avatar"; provider: string }> = [
    { category: "image", provider: input.image_provider },
  ];
  if (input.broll_provider) relevant.push({ category: "video_broll", provider: input.broll_provider });
  if (input.avatar_enabled) relevant.push({ category: "video_avatar", provider: "heygen" });

  for (const { category, provider } of relevant) {
    const adapter = adapters.tryGet(category, provider);
    if (!adapter) {
      warnings.push(`no adapter registered for ${category}/${provider}`);
      continue;
    }
    const caps = adapter.capabilities();
    if (!caps.supported_aspect_ratios.includes(input.aspect_ratio)) {
      violations.push(`aspect_ratio "${input.aspect_ratio}" is not supported by ${provider}`);
    }
    if (!caps.supported_resolutions.includes(input.resolution)) {
      violations.push(`resolution "${input.resolution}" is not supported by ${provider}`);
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

export async function loadReelSetup(
  ctx: ReelSetupStageContext
): Promise<{ reel: Reel; reel_config: ReelConfigRow } | null> {
  if (!ctx.reelId) return null;

  const { data: reel, error } = await ctx.supa.from("reels").select("*").eq("id", ctx.reelId).maybeSingle();
  if (error) throw new Error(`reels lookup failed: ${error.message}`);
  if (!reel) return null;

  const { data: reelConfig, error: configError } = await ctx.supa
    .from("reel_config")
    .select("*")
    .eq("reel_id", ctx.reelId)
    .single();
  if (configError) throw new Error(`reel_config lookup failed: ${configError.message}`);

  return { reel: reel as Reel, reel_config: reelConfig as ReelConfigRow };
}

export async function processReelSetup(
  ctx: ReelSetupStageContext,
  input: ReelSetupInput
): Promise<ReelSetupOutput> {
  const validation = validateReelSetup(input, ctx.adapters);
  if (!validation.ok) {
    throw new Error(`reel-setup validate() failed: ${validation.violations.join("; ")}`);
  }

  let reelId = ctx.reelId;
  let reel: Reel;

  if (!reelId) {
    const { data, error } = await ctx.supa
      .from("reels")
      .insert({
        client_id: ctx.clientId,
        display_name: input.display_name ?? input.topic,
        current_stage: "scene",
      })
      .select("*")
      .single();
    if (error) throw new Error(`reels insert failed: ${error.message}`);
    reel = data as Reel;
    reelId = reel.id;
  } else {
    if (input.display_name) {
      const { error } = await ctx.supa.from("reels").update({ display_name: input.display_name }).eq("id", reelId);
      if (error) throw new Error(`reels update failed: ${error.message}`);
    }
    const { data, error } = await ctx.supa.from("reels").select("*").eq("id", reelId).single();
    if (error) throw new Error(`reels lookup failed: ${error.message}`);
    reel = data as Reel;
  }

  const { data: reelConfigData, error: reelConfigError } = await ctx.supa
    .from("reel_config")
    .upsert(
      {
        reel_id: reelId,
        topic: input.topic,
        total_seconds_target: input.total_seconds_target,
        avatar_enabled: input.avatar_enabled,
        broll_provider: input.broll_provider ?? null,
        image_provider: input.image_provider,
        veo_variant: input.veo_variant,
        outro_provider_override: input.outro_provider_override ?? null,
        avatar_look_id: input.avatar_look_id ?? null,
        aspect_ratio: input.aspect_ratio,
        resolution: input.resolution,
        output_fps: input.output_fps,
      },
      { onConflict: "reel_id" }
    )
    .select("*")
    .single();
  if (reelConfigError) throw new Error(`reel_config upsert failed: ${reelConfigError.message}`);

  return { reel, reel_config: reelConfigData as ReelConfigRow, validation };
}
