/**
 * Stage 3 — Scene / script (spec §7 Stage 3).
 *
 * sceneBrain -> ordered scenes (visual shot-list, no dialogue). Enforces
 * avatar=>hard_cut, last scene NULL, product only if products exist.
 * Review UI: edit any field; add/delete/reorder; per-scene seconds/type;
 * per-scene broll_provider_override; "re-run scene-brain" (regenerate=true
 * here). Shows when an intended continuous boundary is downgraded to
 * hard_cut (§2.4). Cost: none.
 */
import { z } from "zod";
import type { StageContext, StageModule, StageState } from "../types";
import { nextStage } from "../types";
import { PROVIDERS } from "@/src/lib/db/enums";
import type { ReelConfigRow, SceneRow } from "@/src/lib/db/types";
import { isDowngradedToHardCut, supportsEndFrameLookupFor, type SceneLike, type SupportsEndFrameLookup } from "@/src/lib/routing";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { BrandContext } from "@/src/skills/types";
import { SCENE_BRAIN_SYSTEM_PROMPT } from "@/src/skills/scene-brain";

const sceneEntrySchema = z.object({
  id: z.string().uuid().optional(),
  position: z.number().int().nonnegative(),
  type: z.enum(["avatar", "broll"]),
  product_in_scene: z.boolean().optional(),
  seconds: z.number().positive(),
  transition_to_next: z.enum(["continuous", "hard_cut"]).nullable().optional(),
  broll_provider_override: z.enum(PROVIDERS).nullable().optional(),
  end_frame_disabled: z.boolean().optional(),
  description: z.string().nullable().optional(),
});

export const sceneInputSchema = z.object({
  /** Re-run scene-brain and replace the scene list. Falsy/omitted = false. */
  regenerate: z.boolean().optional(),
  /** Full desired scene list (add/edit/reorder/delete by omission) — required unless regenerate=true. */
  scenes: z.array(sceneEntrySchema).optional(),
  /**
   * Per-reel scene-brain instruction, persisted before anything is
   * generated — so it's editable up front and again on every re-run. Empty
   * string resets to the built-in default.
   */
  scene_prompt: z.string().optional(),
});
export type SceneInput = z.infer<typeof sceneInputSchema>;

export interface SceneHint {
  scene_id: string;
  /** True iff the user's stored intent was 'continuous' but it was forced to hard_cut (§2.4). */
  downgraded_to_hard_cut: boolean;
}

export interface SceneOutput {
  scenes: SceneRow[];
  hints: SceneHint[];
}

/** Pure: which boundaries are downgraded from the user's stored 'continuous' intent (§2.4). Exported for tests. */
export function computeSceneHints(
  scenes: SceneLike[],
  reelConfig: Pick<ReelConfigRow, "broll_provider" | "outro_provider_override">,
  supportsEndFrame: SupportsEndFrameLookup
): SceneHint[] {
  return scenes.map((scene, i) => ({
    scene_id: scene.id,
    downgraded_to_hard_cut: isDowngradedToHardCut(scene, scenes[i + 1] ?? null, reelConfig, supportsEndFrame),
  }));
}

/** Defensive re-assertion of the hard business rules, applied at persistence time too (not just in the skill). */
function enforceRules(
  scenes: Array<z.infer<typeof sceneEntrySchema>>,
  avatarEnabled: boolean,
  hasProducts: boolean
): Array<z.infer<typeof sceneEntrySchema>> {
  return scenes.map((scene, i, arr) => {
    const isLast = i === arr.length - 1;
    const type = avatarEnabled ? scene.type : "broll";
    return {
      ...scene,
      type,
      product_in_scene: hasProducts ? (scene.product_in_scene ?? false) : false,
      transition_to_next: isLast ? null : type === "avatar" ? "hard_cut" : scene.transition_to_next ?? null,
    };
  });
}

async function getReelConfig(ctx: StageContext): Promise<ReelConfigRow> {
  const { data, error } = await ctx.supa.from("reel_config").select("*").eq("reel_id", ctx.reelId).single();
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);
  return data as ReelConfigRow;
}

async function getBrandAndProducts(ctx: StageContext): Promise<{ brand: BrandContext; hasProducts: boolean }> {
  const [{ data: clientConfig }, { count }] = await Promise.all([
    ctx.supa.from("client_config").select("*").eq("client_id", ctx.clientId).maybeSingle(),
    ctx.supa.from("products").select("id", { count: "exact", head: true }).eq("client_id", ctx.clientId),
  ]);
  const cfg = clientConfig as { brand_name?: string | null; default_tagline?: string | null; brand_colors?: unknown; fonts?: unknown } | null;
  return {
    brand: {
      brand_name: cfg?.brand_name ?? null,
      default_tagline: cfg?.default_tagline ?? null,
      brand_colors: cfg?.brand_colors ?? null,
      fonts: cfg?.fonts ?? null,
    },
    hasProducts: (count ?? 0) > 0,
  };
}

async function load(ctx: StageContext): Promise<StageState> {
  const { data: scenes, error } = await ctx.supa
    .from("scenes")
    .select("*")
    .eq("reel_id", ctx.reelId)
    .order("position", { ascending: true });
  if (error) throw new Error(`scenes lookup failed: ${error.message}`);
  // scene_prompt comes back resolved (stored override, else the built-in
  // default) so the page can show and edit the real instruction — before the
  // first generation as well as on a re-run.
  const reelConfig = await getReelConfig(ctx);
  return {
    stage: "scene",
    data: {
      scenes: (scenes ?? []) as SceneRow[],
      scene_prompt: reelConfig.scene_prompt ?? SCENE_BRAIN_SYSTEM_PROMPT,
      scene_prompt_is_default: reelConfig.scene_prompt === null,
    },
  };
}

async function process(input: SceneInput, ctx: StageContext): Promise<SceneOutput> {
  // Persist an edited instruction first, so the regenerate below (and every
  // later re-run) uses it rather than the copy this request came in with.
  if (input.scene_prompt !== undefined) {
    const scenePrompt = input.scene_prompt.trim() === "" ? null : input.scene_prompt;
    const { error } = await ctx.supa.from("reel_config").update({ scene_prompt: scenePrompt }).eq("reel_id", ctx.reelId);
    if (error) throw new Error(`reel_config update (scene_prompt) failed: ${error.message}`);
  }

  const reelConfig = await getReelConfig(ctx);
  const { brand, hasProducts } = await getBrandAndProducts(ctx);

  // A prompt-only save must not fall through to the "no scenes supplied =>
  // regenerate" path below: storing the instruction isn't a request to run it.
  if (input.scene_prompt !== undefined && !input.regenerate && !input.scenes) {
    const state = await load(ctx);
    const current = (state.data as { scenes: SceneRow[] }).scenes;
    return { scenes: current, hints: computeSceneHints(current, reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant)) };
  }

  let desired = input.scenes;
  if (input.regenerate || !desired) {
    const generated = await ctx.skills.sceneBrain({
      topic: reelConfig.topic,
      topic_description: reelConfig.topic_description,
      system_prompt: reelConfig.scene_prompt,
      total_seconds_target: reelConfig.total_seconds_target,
      avatar_enabled: reelConfig.avatar_enabled,
      has_products: hasProducts,
      brand,
    });
    desired = generated.scenes.map((s, i) => ({ position: i, ...s }));
  }

  desired = enforceRules(desired, reelConfig.avatar_enabled, hasProducts);

  const { data: existingRows, error: existingError } = await ctx.supa
    .from("scenes")
    .select("id")
    .eq("reel_id", ctx.reelId);
  if (existingError) throw new Error(`scenes lookup failed: ${existingError.message}`);
  const existingIds = new Set(((existingRows ?? []) as Array<{ id: string }>).map((r) => r.id));
  const keepIds = new Set(desired.filter((s) => s.id).map((s) => s.id as string));
  const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
  if (toDelete.length > 0) {
    const { error } = await ctx.supa.from("scenes").delete().in("id", toDelete);
    if (error) throw new Error(`scenes delete failed: ${error.message}`);
  }

  const results: SceneRow[] = [];
  for (const scene of desired) {
    const row = {
      reel_id: ctx.reelId,
      position: scene.position,
      type: scene.type,
      product_in_scene: scene.product_in_scene,
      seconds: scene.seconds,
      transition_to_next: scene.transition_to_next ?? null,
      broll_provider_override: scene.broll_provider_override ?? null,
      end_frame_disabled: scene.end_frame_disabled ?? false,
      description: scene.description ?? null,
    };
    if (scene.id) {
      const { data, error } = await ctx.supa.from("scenes").update(row).eq("id", scene.id).select("*").single();
      if (error) throw new Error(`scenes update failed: ${error.message}`);
      results.push(data as SceneRow);
    } else {
      const { data, error } = await ctx.supa.from("scenes").insert(row).select("*").single();
      if (error) throw new Error(`scenes insert failed: ${error.message}`);
      results.push(data as SceneRow);
    }
  }

  results.sort((a, b) => a.position - b.position);
  const hints = computeSceneHints(results, reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));

  return { scenes: results, hints };
}

async function advance(ctx: StageContext): Promise<import("@/src/lib/db/enums").StageId> {
  const next = nextStage("scene");
  const { error } = await ctx.supa.from("reels").update({ current_stage: next }).eq("id", ctx.reelId);
  if (error) throw new Error(`reels advance failed: ${error.message}`);
  return next;
}

export const sceneStage: StageModule<SceneInput, SceneOutput> = {
  id: "scene",
  inputSchema: sceneInputSchema,
  load,
  process,
  advance,
};
