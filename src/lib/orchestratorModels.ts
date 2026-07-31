/**
 * The selectable orchestrating LLM (reel_config.orchestrator_model) — the model
 * every runtime skill in src/skills/* uses for a given reel. Chosen in Stage 2
 * (reel setup) and applied for that reel's whole lifetime.
 *
 * Mirrors src/lib/brollModels.ts: the value set drives both the zod schema and
 * the setup form's dropdown, so they can't drift.
 */
import type { Provider } from "@/src/lib/db/enums";

export const ORCHESTRATOR_MODELS = [
  "claude-sonnet-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
] as const;
export type OrchestratorModel = (typeof ORCHESTRATOR_MODELS)[number];

export const DEFAULT_ORCHESTRATOR_MODEL: OrchestratorModel = "claude-sonnet-4-5";

export const ORCHESTRATOR_MODEL_LABELS: Record<OrchestratorModel, string> = {
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5": "Claude Opus 5",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
};

/** Which SDK/cost_log provider a model id belongs to. */
export function providerForOrchestratorModel(model: string): Extract<Provider, "anthropic" | "gemini"> {
  return model.startsWith("gemini") ? "gemini" : "anthropic";
}
