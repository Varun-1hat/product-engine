/**
 * model-prompt: lyria-realtime-exp (spec §5). Lyria RealTime streams PCM from
 * WeightedPrompt messages; tempo/density/brightness/scale are CONFIG fields on
 * the session, not prompt text. Called INSIDE src/adapters/music/lyria.ts.
 *
 * Sources: ai.google.dev/gemini-api/docs/realtime-music-generation
 * (verified 2026-07-30).
 */
import type { ModelConstraints, ReelModelContext } from "./constraints";

/**
 * How the orchestrator LLM should WRITE a Lyria prompt.
 *
 * This is close to the OPPOSITE of the Eleven Music brief, which is exactly
 * why the guidance is per-model: Google's documented advice is to "stay
 * simple" because the model understands short terms like "meditation",
 * "eerie", "harp" better than complex descriptions. Lyria is also instrumental
 * by construction, so asking for instrumental output is wasted budget, and its
 * numeric controls (bpm, density, brightness) are session config — a "120 BPM"
 * string in the prompt text does nothing.
 */
export const LYRIA_PROMPT_GUIDANCE = [
  "TARGET MODEL: Google Lyria RealTime (lyria-realtime-exp). Write for it specifically.",
  "KEEP IT SIMPLE AND SHORT. Google's documented guidance is that this model understands terse terms — 'meditation', 'eerie', 'harp' — better than complex descriptions. Emit a short comma-separated list of 3-6 descriptors, NOT prose sentences.",
  "Draw from the three documented categories: a genre, a mood/texture, and one or two instruments.",
  "Genres it knows well include: Lo-Fi Hip Hop, Minimal Techno, Neo-Soul, Bossa Nova, Indie Folk, Synthpop, Trance, Acid Jazz, Afrobeat, Drum & Bass, Baroque, Jazz Fusion, Vaporwave.",
  "Moods/textures it knows well include: Ambient, Bright Tones, Chill, Danceable, Dreamy, Emotional, Ethereal Ambience, Funky, Glitchy Effects, Lo-fi, Psychedelic, Upbeat, Virtuoso.",
  "Instruments it knows well include: 303 Acid Bass, Synth Pads, Moog Oscillations, Harp, Kalimba, Vibraphone, Cello, Flamenco Guitar, Glockenspiel, Mellotron, Trumpet, Sitar.",
  "Do NOT write 'instrumental only' — Lyria generates instrumental music exclusively and cannot produce vocals. The phrase is wasted budget.",
  "Do NOT write BPM, musical key, density or brightness as text ('120 BPM', 'in A minor'). Those are separate session-config fields on this model and are ignored inside the prompt string.",
  "Do NOT write duration or section structure — the adapter captures a fixed length and assembly trims/loops it.",
  "Do NOT write a 'Negative:' line — there is no negative-prompt field, and content-filtered prompts are silently ignored rather than erroring.",
  "Good output: 'lo-fi hip hop, chill, dreamy, warm vibraphone, brushed drums'. Bad output: 'A gentle, contemplative lo-fi hip hop instrumental at 85 BPM in the key of F minor that evokes...'",
].join("\n");

/**
 * Constraints (see ./constraints.ts). Source:
 * ai.google.dev/gemini-api/docs/realtime-music-generation (verified
 * 2026-07-30), which documents raw 16-bit PCM at 48kHz stereo, a
 * WeightedPrompt `{text, weight}` shape, MusicGenerationConfig ranges
 * (guidance [0.0, 6.0] default 4.0; bpm [60, 200]; density [0.0, 1.0];
 * brightness [0.0, 1.0]; temperature [0.0, 3.0] default 1.1), and the
 * limitations "Instrumental only" and "Output audio is always watermarked".
 *
 * The defining difference from Eleven Music: this is a continuous stream with
 * no duration parameter at all, so the adapter captures a fixed length rather
 * than requesting one.
 */
export function lyriaConstraints(_ctx: ReelModelContext): ModelConstraints {
  return {
    model: "Lyria RealTime",
    role: "music",
    source: "https://ai.google.dev/gemini-api/docs/realtime-music-generation",
    verified_on: "2026-07-30",
    items: [
      {
        label: "One track for the whole reel",
        detail:
          "there is no per-scene music. The track is a single bed under every cut and cannot be written around one moment.",
        severity: "quality",
      },
      {
        label: "No duration parameter at all",
        detail:
          "this is a continuous stream, not a file request — the adapter captures a fixed length and assembly trims or loops it. Duration and section structure in the prompt text do nothing.",
        severity: "forced",
      },
      {
        label: "Instrumental by construction",
        detail:
          "this model cannot produce vocals, so 'instrumental only' is wasted budget here — the opposite of the Eleven Music rule, which is why the two prompts must not be written the same way.",
        severity: "quality",
      },
      {
        label: "Tempo, key, density and brightness are session config",
        detail:
          "bpm, scale, density and brightness are separate numeric fields on the session. Writing '120 BPM' or 'in A minor' into the prompt string is silently ignored.",
        severity: "quality",
      },
      {
        label: "Output is always watermarked",
        detail: "Google watermarks every generated track; this cannot be disabled.",
        severity: "quality",
      },
    ],
  };
}
