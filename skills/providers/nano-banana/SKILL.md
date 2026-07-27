---
name: provider-nano-banana
description: Integration facts for the Nano Banana image adapter (Google Gemini 2.5 Flash Image). Apply when building or modifying the `image` adapter, image-gen calls, or image cost logging.
category: image
provider_enum: nano_banana
confidence: high (official Google sources)
verified_on: 2026-07-26
---

# Nano Banana (Gemini 2.5 Flash Image) — image adapter

"Nano Banana" is Google's nickname for **Gemini 2.5 Flash Image**. Integrated **direct** against Google (no aggregator). Per-client Google Gemini API key (a shared agency key may be entered per client if the agency bills centrally).

## SDK (preferred) — `@google/genai` (Node/TS)
```ts
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey /* per-client Gemini key */ });

const res = await ai.models.generateContent({
  model: "gemini-2.5-flash-image",
  contents: [{
    role: "user",
    parts: [
      { text: prompt },
      // 0..N reference images (product photos etc.), chosen by the image-prompt skill:
      { inlineData: { mimeType: "image/png", data: base64 } },
    ],
  }],
  // Aspect ratio control (VERIFY exact key against installed SDK version):
  config: { imageConfig: { aspectRatio: "9:16" } },
});

// Output image bytes:
const part = res.candidates[0].content.parts.find(p => p.inlineData);
const outMime = part.inlineData.mimeType;      // e.g. "image/png"
const outB64  = part.inlineData.data;          // base64 → decode → upload to Storage
```

## REST equivalent (if not using the SDK)
- `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`
- Header: `x-goog-api-key: <GEMINI_API_KEY>`, `Content-Type: application/json`
- Body: `{ "contents": [ { "parts": [ {"text": "..."}, {"inline_data": {"mime_type":"image/png","data":"<b64>"}} ] } ] }`
- Response image: `candidates[0].content.parts[].inline_data.data` (base64), mime at `.inline_data.mime_type`.
- ⚠️ Do NOT use a `/v1beta/interactions` endpoint or `input`/`output_image` fields — that shape is wrong; the real API is `:generateContent` with `contents`/`parts`/`inline_data`.

## Capabilities (for adapter `capabilities()`)
- `accepted_inputs`: text prompt + up to several reference images (inline base64 or Files API).
- `supported_aspect_ratios`: 1:1, 9:16, 16:9 (and more); reel uses its one configured aspect.
- Synchronous — returns inline, **no polling/job needed**. `async: false`.
- Fast + cheap relative to video; safe to fan out per scene in parallel.

## Cost → rate_card
- Billing unit: **per image**. `unit_type = 'image'`, `units = 1` per generated image.
- Standard: **$0.039 / image**. Batch: $0.0195 / image (only if batch mode used).
- Seed `rate_card`: `(provider=nano_banana, unit_type='image', unit_cost_usd=0.039, source_note='Gemini API pricing 2026-07, $30/1M output tokens ≈ 1290 tok ≈ $0.039/img ≤1024px')`.
- Every generate/redo emits a `cost_log` row (`call_type` generate|redo, `call_status='success'`; on billed failure `failed_billed`).

## Sources (verify at integration)
- https://ai.google.dev/gemini-api/docs/image-generation
- https://ai.google.dev/gemini-api/docs/pricing
