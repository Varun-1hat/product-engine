---
name: provider-higgsfield
description: Integration facts for the Higgsfield b-roll video adapter (WAVE 2, lower confidence — verify against official docs before building). Apply when building/modifying the Higgsfield video_broll adapter.
category: video_broll
provider_enum: higgsfield
confidence: LOW (third-party sources; MUST verify at cloud.higgsfield.ai before building)
verified_on: 2026-07-26
---

# Higgsfield — b-roll video adapter (WAVE 2)

⚠️ **Wave 2, not wave 1.** Build the adapter + config only after Veo/Nano Banana/HeyGen are live. The details below are from third-party write-ups, **not** official docs — **verify every endpoint, field, and price against the official Higgsfield developer docs (dashboard at `cloud.higgsfield.ai`) before writing the adapter.** Do a smoke test.

Per-client Higgsfield API key. Base URL (verify): `https://api.higgsfield.ai/v1`. Auth: **`Authorization: Bearer <client key>`**.

## Image-to-video (verify)
```json
POST /v1/generations
{
  "task": "image-to-video",
  "model": "<higgsfield video model id>",
  "input_image": "<url or base64>",     // START frame only (see capability note)
  "prompt": "<motion brief>",
  "duration": 8,
  "fps": 30,
  "motion_intensity": "medium"
}
```
- Returns `202` + a `generation_id`. Poll `GET /v1/generations/{id}` → `status` becomes `"completed"` with an output URL. Webhooks available as an alternative. `async: true` → use the `jobs` queue.

## Capability note that affects routing
- The documented image-to-video takes a **single `input_image` (start frame)** — no evidence of an end/last frame. Set **`supports_end_frame: false`** unless official docs prove otherwise. Consequence: when Higgsfield is the effective model for a scene, that scene's outgoing boundary is forced to **`hard_cut`** (it cannot land on a shared end frame). If Higgsfield DOES support an end frame, flip the capability and the routing follows automatically.
- Populate the rest of `capabilities()` (aspect ratios, resolutions, min/max duration, max reference images) from the official docs at integration.

## Cost → rate_card
- Pay-as-you-go / credit-based; **exact $/unit is not public** — pull the current credit price + per-generation credit cost from the Higgsfield dashboard/plan at integration and derive $/unit. Flag this as a **credit/subscription-derived** rate (`rate_card.source_note`), and use an optional per-client override row if the client's plan changes $/credit.
- `unit_type`: likely `'second'` or `'credit'` — confirm. Until confirmed, mark estimates as approximate and `rate_missing=false` only once a real rate row exists.

## Sources (LOW confidence — replace with official docs)
- https://apidog.com/blog/higgsfield-api/  (third-party)
- Official: cloud.higgsfield.ai dashboard → API section (authoritative; requires login)
