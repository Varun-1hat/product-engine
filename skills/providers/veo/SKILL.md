---
name: provider-veo
description: Integration facts for the Veo 3.1 b-roll video adapter (Google, direct). Apply when building/modifying the `video_broll` Veo adapter, start+end-frame clip gen, async video jobs, or video cost logging.
category: video_broll
provider_enum: veo
confidence: high (official Google sources + @google/genai SDK)
verified_on: 2026-07-26
---

# Veo 3.1 — b-roll video adapter (start image + end image → clip)

Google's native video model, integrated **direct** (per-client Gemini API key). This is the wave-1 b-roll generator. It is the reason the shared-boundary-frame continuity design works: **Veo 3.1 supports BOTH a first frame and a last frame** ("frames-to-video" interpolation).

## SDK — `@google/genai` (Node/TS), async long-running operation
```ts
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey /* per-client Gemini key */ });

let op = await ai.models.generateVideos({
  model: "veo-3.1-generate-preview",          // standard; fast: "veo-3.1-fast-generate-preview"
  prompt,                                       // motion/shot brief from the broll model-prompt skill
  image: firstFrame,                            // START image  { imageBytes: b64, mimeType } or Files API ref
  config: {
    lastFrame: lastFrame,                       // END image → interpolation. Enables continuous seams.
    aspectRatio: "9:16",                        // reel's configured aspect (16:9 | 9:16)
    resolution: "1080p",                        // "720p" | "1080p" (+ "4k" standard only)
    negativePrompt,                             // optional
    numberOfVideos: 1,
  },
});

// Poll the operation until done:
while (!op.done) {
  await sleep(10_000);
  op = await ai.operations.getVideosOperation({ operation: op });
}
const video = op.response.generatedVideos[0].video;   // download via ai.files.download({ file: video }) or video.uri
```

## Capabilities (for adapter `capabilities()`)
- **`supports_end_frame: true`** ← drives continuity routing (see below).
- `supported_aspect_ratios`: 16:9, 9:16. `supported_resolutions`: 720p, 1080p (4k standard-tier only).
- `min_duration_s`/`max_duration_s`: Veo produces ~**8s** clips (verify whether 3.1 accepts a 4/6/8 `durationSeconds`; default to 8). Requesting a shorter scene ⇒ generate at model duration, **trim in Stage 6**.
- `max_reference_images`: up to 3 (plus first/last frame).
- `async: true` (long-running op). Prefer the Postgres `jobs` queue + worker poll; no Veo webhook, so poll `getVideosOperation`. Result URI is short-lived (~2 days) → **download to Storage immediately**.
- **Native audio:** Veo 3.1 generates audio. This build **keeps** it: the track is demuxed into the clip's own `clip_audio` asset, which the user can switch off, replace or trim, and which is mixed over the music bed at assembly. The picture lane is still normalized with `-an` — the audio rejoins it as a separate lane, so the continuous-seam head-frame trim can't drag the sound out of sync.

## Continuity routing rule (deterministic)
A b-roll boundary N→N+1 may be `continuous` (shared end/start frame) **only if scene N's effective b-roll model has `supports_end_frame=true`**. Veo satisfies this. If scene N's model lacks it, the boundary is forced to `hard_cut`. The outro clip needs `supports_end_frame` too (last-scene end frame → branded end frame); if the outro model lacks it, fall back to a deterministic crossfade-to-endframe.

## Cost → rate_card (per SECOND of generated video)
- `unit_type = 'second'`. **Billable seconds = the model's produced duration (default 8), NOT the trimmed length** — Veo bills for what it generates. `estimate()` must use `billableDuration(requested)` (clamp to Veo's supported set).
- Rates (720p/1080p): **Standard $0.40/s**, **Fast $0.10/s**, **Lite $0.05/s**. 4k: standard $0.60/s, fast $0.30/s. 1080p fast $0.12/s, lite $0.08/s.
- Seed `rate_card` rows per (provider=veo, unit_type='second', unit_cost_usd=<tier rate for the reel's resolution/model variant>). Because rate varies by variant+resolution, resolve rate from the chosen model variant + `reel_config.resolution`.
- Log every generate/redo; a Veo redo of an 8s 1080p standard clip = 8 × $0.40 = **$3.20**.

## Gotchas
- `lastFrame` goes inside `config`, not top-level. Some forum reports of last-frame quirks → verify with a smoke test.
- "Gemini omni" in the brief = Veo (no separate model).
- Charged only on successful generation (failed unbilled), but log billed failures if the provider indicates one.

## Sources (verify at integration)
- https://ai.google.dev/gemini-api/docs/veo
- https://developers.googleblog.com/introducing-veo-3-1-and-new-creative-capabilities-in-the-gemini-api/
- https://ai.google.dev/gemini-api/docs/pricing
