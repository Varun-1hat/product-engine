---
name: provider-<slug>
description: Integration facts for the <Model Name> <category> adapter (<vendor>, direct|via-aggregator). Apply when building/modifying the `<category>` <provider> adapter, <the specific operations>, or <provider> cost logging.
category: <image | video_broll | video_avatar | tts | music>
provider_enum: <the exact PROVIDERS value in src/lib/db/enums.ts>
confidence: <high | medium | low> (<what backs it — official docs? SDK source? a support reply? a smoke test?>)
verified_on: <YYYY-MM-DD>
---

<!--
==============================================================================
TEMPLATE — copy this directory to `skills/providers/<provider>/SKILL.md`.
==============================================================================

WHAT THIS FILE IS: the researched provider facts, written down ONCE, before
any adapter code exists. It is read by a human or a coding agent at build
time — it has no runtime role and nothing imports it.

WHY IT EXISTS SEPARATELY FROM THE ADAPTER: the adapter says what the code
does; this says what the PROVIDER does and where that was verified. When a
model's behaviour surprises you six months from now, this is the file that
tells you whether the code is wrong or the docs changed. Every capability
number in the adapter should be traceable to a line here.

RULES:
  - Cite sources. A number with no source is a guess, and guesses about
    durations and rates cost real money.
  - Set `confidence` honestly, and say what backs it. `medium` with a note
    reading "duration control not confirmed — verify with a smoke test" is
    far more useful than an unqualified `high`.
  - Bump `verified_on` whenever you re-check, even if nothing changed.
  - Record what the provider CANNOT do as prominently as what it can. The
    absent capability (no end frame, no duration control, no negative prompt)
    is what changes routing, prompts, and cost.
  - Keep it short. This is a fact sheet, not a tutorial — the existing four
    (veo, heygen, nano-banana, higgsfield) are the length to aim for.

Delete this comment block in your copy.
==============================================================================
-->

# <Model Name> — <category> adapter (<one-line: inputs → output>)

One paragraph: what this model is, how it is integrated (direct with a
per-client key, or via an aggregator), which wave it belongs to, and the ONE
fact that most shapes the integration — e.g. "supports both a first and a last
frame, which is what makes the shared-boundary continuity design work", or
"realtime stream, not a file, so generate() collects chunks and wraps them".

## SDK / endpoints

```ts
// The minimal working call, with the real field names and where each argument
// comes from. Note anything counter-intuitive inline — e.g. Veo's `lastFrame`
// goes inside `config`, not at the top level, which is a 20-minute mistake.
```

Auth: `<header or SDK field>`, per-client key from `provider_keys` (or shared
with `<sibling provider>` — if so, add it to `GOOGLE_BACKED_PROVIDERS`-style
fallback in src/lib/crypto/vault.ts and say why here).

Async shape: `<synchronous | long-running operation + poll | webhook>`. If
polled: what is the operation handle, and how long do result URLs stay valid?
Short-lived URLs mean download to Storage immediately.

## Capabilities (for the adapter's `capabilities()`)

Map these one-to-one onto `AdapterCapabilities` — this section is what the
adapter's capability table is transcribed from.

- `supports_end_frame`: `<true|false>` ← drives continuity routing; if false,
  no end image is generated for scenes on this model and every boundary out of
  them is forced to `hard_cut`.
- `supports_duration_control`: `<true|false>` ← if false, clip length is
  whatever the model returns and Stage 6 trims it.
- `supported_aspect_ratios` / `supported_resolutions`: `<list>`. Note any
  combination that is conditional (e.g. "1080p renders at 8s only").
- `min_duration_s` / `max_duration_s` / `supported_durations_s`: `<values>`.
  Is the duration a free number or a discrete set?
- `max_reference_images` / `max_reference_videos` / `max_avatar_ids`.
- `emits_audio`: `<true|false>` — this build is silent, so strip it on ingest.
- `async`, `billing_unit`.

If one adapter will front several models, give each its own row/table here.
That is where a `<provider>Capabilities.ts` table comes from.

## Prompting

What this model wants in a prompt, in the provider's own words: structure,
vocabulary it is trained on, whether there is a separate negative-prompt
field, and what is silently ignored (numbers that are really API fields, e.g.
BPM or aspect ratio written as text). This section is the raw material for
`src/skills/model-prompt/<model>.ts` — distil it there, do not duplicate it.

## Routing implications

Anything that changes behaviour OUTSIDE the adapter: continuity boundaries,
whether it can serve as the outro model, whether the setup form must restrict
resolutions, whether Stage 6 must always trim. Be explicit — this is what
someone reads when the pipeline does something unexpected.

## Cost → `rate_card`

- `unit_type`: `<image | second | video | credit | character>`.
- What is actually billed — the produced value or the requested one? (Veo
  bills the generated 8s even when the scene is 5s and gets trimmed.)
- Does the rate vary by variant/tier/resolution? If so the adapter emits a
  composed `variant` string and the seed rows must match it exactly — Veo uses
  `<tier>@<resolution>` via `composeVeoVariant()`. A mismatch does not throw;
  it silently reports `rate_missing`.
- Published rates, with the date and source.
- The seed row, ready to paste:

```sql
insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
values ('<provider>', '<unit_type>', <'variant' | null>, <rate>, null, '<source + date>');
```

If the rate is not public (credit-plan derived, negotiated), say so and leave
it UNSEEDED deliberately — `resolveRate()` then reports `rate_missing=true` /
`cost_usd=NULL`, which shows as "rate not configured" rather than a wrong
number. Higgsfield is the worked example of doing this on purpose.

## Gotchas

The things that cost hours. Rate limits and whether listing endpoints
paginate (HeyGen's do, default page size 20 — walk them or entries silently go
missing). Fields that are nested where you would not expect. Whether failed
generations are billed. Anything where community guides are wrong.

## Sources (verify at integration)

- <official API reference URL>
- <pricing page URL>
- <changelog / launch post URL>
