/**
 * Runtime skills (brief §9) — product-internal, versioned, swappable LLM
 * calls. Distinct from the executing-agent skills under skills/providers/*
 * (§14). LLM = the reel's orchestrator model (src/skills/llm.ts).
 */
import type { Boundary, SceneType } from "@/src/lib/db/enums";
import type { LlmUsageSink } from "./llm";
import type { TargetModel } from "./model-prompt/guidance";
import type { ModelConstraints, ReelModelContext } from "./model-prompt/constraints";

export interface BrandContext {
  brand_name?: string | null;
  default_tagline?: string | null;
  brand_colors?: unknown;
  fonts?: unknown;
}

export interface SceneBrainInput {
  topic: string;
  /** Longer brief from Stage 2 — what content to keep and how to treat it. */
  topic_description?: string | null;
  /** Per-reel replacement for the built-in instruction (scene page). */
  system_prompt?: string | null;
  total_seconds_target: number;
  avatar_enabled: boolean;
  brand: BrandContext;
  /**
   * Limits of the models chosen at reel setup (src/lib/modelConstraints.ts).
   * Appended to the system prompt AFTER `system_prompt`, so a customised
   * instruction cannot drop them — without this the scene script allocates
   * durations and transitions the chosen model cannot honour, and every
   * downstream stage inherits the mismatch.
   */
  model_constraints?: ModelConstraints[];
}

export interface SceneInstructionInput {
  topic: string;
  topic_description?: string | null;
  brand: BrandContext;
  avatar_enabled: boolean;
  total_seconds_target: number;
  /** The instruction in force right now — the built-in default, or this reel's custom one. */
  current_instruction: string;
}

export interface SceneInstructionOutput {
  /** Replacement text for reel_config.scene_prompt. */
  instruction: string;
}

/** One neighbouring shot, as much of it as a rewrite needs to stay continuous with. */
export interface SceneDescriptionNeighbour {
  type: SceneType;
  seconds: number;
  description: string | null;
}

export interface SceneDescriptionInput {
  topic: string;
  topic_description?: string | null;
  brand: BrandContext;
  /** The slot being rewritten. Everything here is fixed; only the prose changes. */
  scene: {
    position: number;
    type: SceneType;
    seconds: number;
    transition_to_next: Boundary | null;
    /** The description being replaced — supplied so the rewrite can avoid paraphrasing it. */
    description: string | null;
  };
  previous_scene?: SceneDescriptionNeighbour | null;
  next_scene?: SceneDescriptionNeighbour | null;
  /** Same constraint sets scene-brain receives — a rewrite must stay renderable too. */
  model_constraints?: ModelConstraints[];
}

export interface SceneDescriptionOutput {
  description: string;
}

export interface SceneBrainSceneOutput {
  type: SceneType;
  seconds: number;
  transition_to_next: Boundary | null;
  description: string;
}

export interface SceneBrainOutput {
  scenes: SceneBrainSceneOutput[];
}

export interface ImagePromptBoundaryContext {
  role: "start" | "end";
  shared: boolean;
  neighborDescription?: string;
}

export interface ImagePromptInput {
  scene: { description: string | null; type: SceneType; seconds: number };
  boundary_context?: ImagePromptBoundaryContext;
  brand: BrandContext;
}

export interface ImagePromptOutput {
  prompt: string;
  reference_paths: string[];
}

export interface BriefJudgeInput {
  assetRef: { url?: string; storage_path?: string; description?: string };
  brief: string;
  brand: BrandContext;
}

export interface BriefJudgeOutput {
  score: number;
  notes: string;
}

export interface MusicPromptInput {
  topic: string;
  topic_description?: string | null;
  total_seconds_target: number;
  /** Pacing hint — more scenes in the same runtime means faster cutting. */
  scene_count?: number | null;
  brand: BrandContext;
}

export interface MusicPromptOutput {
  prompt: string;
}

/**
 * `target` is the generation model the returned prompt will be sent to
 * (src/skills/model-prompt/guidance.ts). Supplying it makes the skill write a
 * prompt optimised for that model instead of a model-agnostic one; omitting it
 * preserves the original generic behaviour. It is a per-call argument rather
 * than a registry-level binding because it varies per scene — a scene can
 * override its b-roll provider independently of the reel default.
 *
 * `ctx` resolves that model's hard limits against the reel (and, where the
 * caller knows it, the individual scene — see ReelModelContext.uses_end_frames).
 * Also per-call for the same reason: the b-roll model that will run a scene,
 * and therefore the duration it will render at, is a per-scene fact. Omitting
 * `ctx` degrades to guidance-only, never an error.
 */
export interface SkillRegistry {
  sceneBrain(input: SceneBrainInput): Promise<SceneBrainOutput>;
  /** Re-rolls one scene's description without disturbing the rest of the list. */
  sceneDescription(input: SceneDescriptionInput): Promise<SceneDescriptionOutput>;
  /** Rewrites scene-brain's own instruction (reel_config.scene_prompt) for this reel. */
  sceneInstruction(input: SceneInstructionInput): Promise<SceneInstructionOutput>;
  imagePrompt(input: ImagePromptInput, target?: TargetModel, ctx?: ReelModelContext): Promise<ImagePromptOutput>;
  brandStyleLock(
    prompt: string,
    brand: BrandContext,
    refs?: string[],
    target?: TargetModel,
    ctx?: ReelModelContext
  ): Promise<string>;
  musicPrompt(input: MusicPromptInput, target?: TargetModel, ctx?: ReelModelContext): Promise<MusicPromptOutput>;
  briefJudge(input: BriefJudgeInput): Promise<BriefJudgeOutput>;
}

/**
 * `onUsage`, when supplied, is bound to every skill in the registry — so a
 * ctx-bound registry (src/lib/context.ts) writes each LLM call's tokens to
 * cost_log without any call site having to know about billing.
 *
 * `model` is the reel's orchestrating LLM (reel_config.orchestrator_model),
 * bound the same way so every skill call for that reel uses the one model the
 * user picked in Stage 2 — call sites never choose it.
 *
 * `apiKey` is the client's own orchestrator key when one is configured
 * (src/lib/context.ts); omitted = the agency-level env key.
 */
export async function createSkillRegistry(
  onUsage?: LlmUsageSink,
  model?: string,
  apiKey?: string
): Promise<SkillRegistry> {
  const [
    { sceneBrain },
    { sceneDescription },
    { sceneInstruction },
    { imagePrompt },
    { brandStyleLock },
    { musicPrompt },
    { briefJudge },
  ] = await Promise.all([
    import("./scene-brain"),
    import("./scene-description"),
    import("./scene-instruction"),
    import("./image-prompt"),
    import("./brand-style-lock"),
    import("./music-prompt"),
    import("./brief-judge"),
  ]);
  return {
    sceneBrain: (input) => sceneBrain(input, onUsage, model, apiKey),
    sceneDescription: (input) => sceneDescription(input, onUsage, model, apiKey),
    sceneInstruction: (input) => sceneInstruction(input, onUsage, model, apiKey),
    imagePrompt: (input, target, ctx) => imagePrompt(input, onUsage, model, target, ctx, apiKey),
    brandStyleLock: (prompt, brand, refs, target, ctx) =>
      brandStyleLock(prompt, brand, refs, onUsage, model, target, ctx, apiKey),
    musicPrompt: (input, target, ctx) => musicPrompt(input, onUsage, model, target, ctx, apiKey),
    briefJudge: (input) => briefJudge(input, onUsage, model, apiKey),
  };
}
