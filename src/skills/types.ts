/**
 * Runtime skills (brief §9) — product-internal, versioned, swappable LLM
 * calls. Distinct from the executing-agent skills under skills/providers/*
 * (§14). LLM = Claude (src/skills/llm.ts). Not logged to cost_log
 * (Assumption 8 — agency overhead).
 */
import type { Boundary, SceneType } from "@/src/lib/db/enums";
import type { LlmUsageSink } from "./llm";

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
  has_products: boolean;
  brand: BrandContext;
}

export interface SceneBrainSceneOutput {
  type: SceneType;
  product_in_scene: boolean;
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

export interface ImagePromptProductRef {
  id: string;
  name: string;
  photo_paths: string[];
}

export interface ImagePromptInput {
  scene: { description: string | null; type: SceneType; product_in_scene: boolean; seconds: number };
  boundary_context?: ImagePromptBoundaryContext;
  brand: BrandContext;
  products: ImagePromptProductRef[];
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

export interface SkillRegistry {
  sceneBrain(input: SceneBrainInput): Promise<SceneBrainOutput>;
  imagePrompt(input: ImagePromptInput): Promise<ImagePromptOutput>;
  brandStyleLock(prompt: string, brand: BrandContext, refs?: string[]): Promise<string>;
  briefJudge(input: BriefJudgeInput): Promise<BriefJudgeOutput>;
}

/**
 * `onUsage`, when supplied, is bound to every skill in the registry — so a
 * ctx-bound registry (src/lib/context.ts) writes each LLM call's tokens to
 * cost_log without any call site having to know about billing.
 */
export async function createSkillRegistry(onUsage?: LlmUsageSink): Promise<SkillRegistry> {
  const [{ sceneBrain }, { imagePrompt }, { brandStyleLock }, { briefJudge }] = await Promise.all([
    import("./scene-brain"),
    import("./image-prompt"),
    import("./brand-style-lock"),
    import("./brief-judge"),
  ]);
  return {
    sceneBrain: (input) => sceneBrain(input, onUsage),
    imagePrompt: (input) => imagePrompt(input, onUsage),
    brandStyleLock: (prompt, brand, refs) => brandStyleLock(prompt, brand, refs, onUsage),
    briefJudge: (input) => briefJudge(input, onUsage),
  };
}
