---
name: provider-heygen
description: Integration facts for the HeyGen Cinematic Avatar video_avatar adapter and the Stage-1 avatar-looks pull. Apply when building/modifying avatar clip gen, avatar onboarding, async avatar jobs/webhooks, or avatar cost logging.
category: video_avatar
provider_enum: heygen
confidence: high (brief-specified + HeyGen docs)
verified_on: 2026-07-26
---

# HeyGen Cinematic Avatar — avatar adapter (silent)

Per-client HeyGen API key (each client's key scopes their own avatars + billing). Base URL `https://api.heygen.com`. Auth header: **`x-api-key: <client key>`**.

## Stage-1: pull avatar looks (onboarding)
- `GET /v3/avatars/looks` → list; each look has an id, `preview_image_url`, `preview_video_url`. Display previews for selection; a client may have multiple avatars. Store in `avatars` table.

## Stage-5: generate a silent Cinematic Avatar clip
- `POST /v3/videos` with:
```json
{
  "type": "cinematic_avatar",
  "prompt": "<shot brief — NO script/voice, clips are silent>",
  "avatar_id": ["look_id_1", "look_id_2"],      // 1–3 look ids
  "references": [                                  // optional product photos etc.
    { "type": "url",      "url": "https://..." },
    { "type": "asset_id", "asset_id": "..." },
    { "type": "base64",   "data": "..." }
  ],
  "aspect_ratio": "9:16",                          // "9:16" | "1:1"
  "resolution": "1080p",                           // "720p" | "1080p"
  "duration": 8,                                    // 4–15 s
  "callback_url": "https://<app>/api/webhooks/heygen?token=<callback_token>"
}
```
- **Combined reference budget: 3 videos / 9 images** across looks + references.
- Routing: avatar-only = looks + prompt; avatar+product = looks + prompt + product photos as `references` (NO Nano Banana composite needed). Avatar clips **skip Stage 4** entirely.

## Async handling
- Returns a video id. Either **poll** `GET /v3/videos/{id}` (status: pending/processing/completed/failed) **or** use the `callback_url` webhook events **`avatar_video.success`** / **`avatar_video.fail`**. Prefer webhook; fall back to worker poll via the `jobs` queue. Authenticate inbound webhooks with the per-job `callback_token`.
- On success, download the rendered mp4 to Storage.

## Cost → rate_card  (⚠️ FLAT PER VIDEO — resolves brief Q2)
- Cinematic Avatar is billed a **flat rate per video** (4–15s, 720p/1080p) — **NOT per second**. Rate: **$7.00 / video**.
- `unit_type = 'video'`, `units = 1` per generate. Seed `rate_card`: `(provider=heygen, unit_type='video', unit_cost_usd=7.00, source_note='HeyGen API Cinematic Avatar flat per-video 2026-07')`.
- Consequence to surface in the UI estimate: **every avatar clip and every avatar redo = $7.00**, regardless of duration/resolution. This dominates reel cost — warn before redo.
- Prepaid USD wallet; check balance `GET /v3/users/me → wallet`. (Other HeyGen engines bill per-second — NOT used here; Cinematic Avatar only for this build.)

## Deferred seam (build nothing now)
- Talking avatar (avatar + script + voice) is the VO path — one adapter swap when VO returns. Keep the `video_avatar` contract able to carry a script/voice field later; do not implement it.

## Sources (verify at integration)
- https://developers.heygen.com/docs/pricing
- Brief §5.1, §5.5, §6 (Cinematic Avatar request shape)
