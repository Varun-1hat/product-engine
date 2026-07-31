/**
 * model-prompt: elevenlabs music_v1 (spec §5). Eleven Music takes a single
 * free-text prompt; length/structure are separate API concerns (the adapter
 * passes duration_s). Called INSIDE src/adapters/music/elevenlabs.ts.
 *
 * Sources: elevenlabs.io/docs/overview/capabilities/music/best-practices
 * (verified 2026-07-30).
 */
import type { ModelConstraints, ReelModelContext } from "./constraints";

/**
 * How the orchestrator LLM should WRITE an Eleven Music prompt.
 *
 * The two findings that matter most and differ from Lyria: this model CAN
 * produce vocals, so instrumental output must be asked for explicitly; and
 * ElevenLabs state outright that prompt length does not correlate with
 * quality — a focused phrase beats a paragraph of competing instructions.
 */
export const ELEVENLABS_PROMPT_GUIDANCE = [
  "TARGET MODEL: ElevenLabs Eleven Music (music_v1). Write for it specifically.",
  "Order the prompt: genre and mood first, then instrumentation, then technical specs. ElevenLabs document this sequence as the effective one.",
  "BE CONCISE. ElevenLabs state explicitly that prompt length and detail do NOT correlate with output quality — 'rainy day jazz cafe, warm upright piano, brushed drums, 85 BPM' beats a paragraph. Aim for one or two tight sentences.",
  "MANDATORY: include the exact phrase 'instrumental only'. This model generates vocals by default and a vocal track is unusable under a product ad.",
  "Be specific about genre rather than generic ('energetic 1980s synth-pop with a driving drum-machine beat', not 'upbeat music').",
  "Name the instruments you actually want. Prefix a single featured instrument with 'solo' (e.g. 'solo electric guitar').",
  "Technical specs this model accepts and rewards, when you have a clear intent: tempo as '120 BPM', key as 'in A minor', and tone words such as raw, live, breathy, aggressive, polished. Including tempo + key + tone together is documented to improve output consistency.",
  "High-level intent framing works well and is worth one clause — e.g. 'sounds like the bed music for a premium sneaker ad'.",
  "Do NOT specify duration, section timings, or lyric timing — this pipeline passes duration as a separate API field and assembly trims/loops the track.",
  "Do NOT write a 'Negative:' line — there is no negative-prompt field.",
].join("\n");

/**
 * Constraints (see ./constraints.ts). Source:
 * elevenlabs.io/docs/api-reference/music/compose (verified 2026-07-30), where
 * `music_length_ms` is documented as "Must be between 3000ms and 600000ms" and
 * `model_id` valid values are `music_v1` (default) and `music_v2`.
 *
 * The 10–300s figures below are THIS BUILD's window, not the model's: they
 * mirror ELEVENLABS_CONFIG.minDurationS/maxDurationS, which the music stage
 * clamps the reel target into. They are restated here rather than imported so
 * this module stays client-importable (see ./constraints.ts header). The gap
 * between the two windows is recorded as a follow-up.
 */
export function elevenLabsConstraints(_ctx: ReelModelContext): ModelConstraints {
  return {
    model: "ElevenLabs Music",
    role: "music",
    source: "https://elevenlabs.io/docs/api-reference/music/compose",
    verified_on: "2026-07-30",
    items: [
      {
        label: "One track for the whole reel",
        detail:
          "there is no per-scene music. The track is a single bed that has to work under every cut, so it must not be written around one moment in the reel.",
        severity: "quality",
      },
      {
        label: "Track length is set by the reel, not the prompt",
        detail:
          "length is a separate API field, held by this build between 10 and 300 seconds, and assembly trims or loops the result to the reel's real runtime. Duration, section timings and 'ends at 0:30' in the prompt text are ignored.",
        severity: "quality",
      },
      {
        label: "Vocals unless told otherwise",
        detail:
          "this model sings by default and a vocal track is unusable under a product ad, so 'instrumental only' must appear in the prompt. The adapter appends it if missing, but relying on that wastes the model's own planning.",
        severity: "forced",
      },
      {
        label: "No negative-prompt field",
        detail: "there is nothing to avoid-list against; state the sound you want.",
        severity: "quality",
      },
    ],
  };
}

/**
 * Deterministic guard, in the same spirit as scene-brain's post-call
 * re-assertion: a vocal track is unusable here, so 'instrumental only' is
 * enforced in code rather than trusted to the prompt.
 */
export function modelPromptElevenLabs(genericPrompt: string): { prompt: string } {
  const prompt = genericPrompt.trim();
  const hasInstrumental = /\binstrumental\b/i.test(prompt);
  return { prompt: hasInstrumental ? prompt : `${prompt}, instrumental only` };
}
