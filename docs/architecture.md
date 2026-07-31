# Architecture & extension guide

How this codebase is layered, and the ordered checklist for adding a new
model, provider, skill, stage or job without breaking the seams that make
those additions cheap.

Every file type below has a **copy-from template** that is real, compiled,
tested code — not a snippet in a doc. Copy the template, do not copy a
neighbouring implementation: templates carry the reasoning and the traps, and
they break in CI if a contract changes.

---

## The layers

```
app/(app)/**          pages           React, no business logic
app/api/**            route handlers  parse -> build ctx -> call a stage. Thin.
  │
src/stages/**         orchestration   WHAT to generate, in what order. Owns the DB and billing.
  │                                   Resolves (category, effective provider). Never names a model.
  ├── src/lib/routing.ts               which model is effective for this scene
  ├── src/skills/**   runtime skills   LLM calls: scene plan, prompts, judging
  │     └── model-prompt/**            per-MODEL prompt guidance + payload shaping (pure)
  ├── src/adapters/** adapters         the ONLY layer that knows a provider's API
  ├── src/lib/cost/** cost engine      the ONLY layer that knows dollars
  ├── src/lib/jobs/** jobs             inline execution + provider-async reconciliation
  └── src/lib/storage, crypto/vault, versioning
```

**The spine is `src/adapters/types.ts`.** Orchestration talks to that
interface and nothing else, which is why a new provider is additive: a file,
a registry line, an enum value, and a rate row. If you find yourself editing a
stage to add a model, stop — something has leaked out of the adapter.

### Who is allowed to know what

| Fact | Lives in | Never in |
|---|---|---|
| Provider API shape, endpoints, SDK calls | the adapter | stages, routes, UI |
| Model ids, base URLs, tuning knobs | `src/adapters/config.ts` | inline in the adapter |
| What a model can/can't do | `capabilities()` | mirrored in the UI or a stage |
| Dollars, rates | `src/lib/cost/engine.ts` + `rate_card` | adapters (they report units only) |
| How to write a prompt for a model | `src/skills/model-prompt/<model>.ts` | the adapter, the skill |
| Which model runs for a scene | `src/lib/routing.ts` | an `if (provider === …)` anywhere |
| Decrypted provider keys | `src/lib/crypto/vault.ts`, via `ctx.keys` | app state, logs, the client |

### Five invariants

1. **Adapters never price.** They report `units` / `unit_type` / `variant`;
   the stage logs, the cost engine resolves $ from `rate_card`.
2. **`estimate()` never calls a provider.** It runs on every page load.
3. **Stages never name a concrete model.** `(category, effective provider)`
   through the registry, always.
4. **Asset versions are immutable.** New file = new version. Revert is a
   pointer move, never a delete or an overwrite.
5. **`capabilities()` is the single source of truth.** The setup UI, the
   validation, and the continuity rule all read it — do not mirror it.

---

## Templates

| Adding | Copy | To |
|---|---|---|
| A provider adapter | [`src/adapters/_template/adapter.ts`](../src/adapters/_template/adapter.ts) | `src/adapters/<category>/<provider>.ts` |
| Its tests | [`src/adapters/_template/adapter.test.ts`](../src/adapters/_template/adapter.test.ts) | `src/adapters/<category>/<provider>.test.ts` |
| Per-model prompt handling | [`src/skills/model-prompt/_template.ts`](../src/skills/model-prompt/_template.ts) | `src/skills/model-prompt/<model>.ts` |
| A runtime (LLM) skill | [`src/skills/_template.skill.ts`](../src/skills/_template.skill.ts) | `src/skills/<skill-name>.ts` |
| A pipeline stage | [`src/stages/_template/index.ts`](../src/stages/_template/index.ts) | `src/stages/<stage>/index.ts` |
| A job handler | [`src/lib/jobs/_template.ts`](../src/lib/jobs/_template.ts) | `src/lib/jobs/<job>.ts` |
| Provider research notes | [`skills/providers/_template/SKILL.md`](../skills/providers/_template/SKILL.md) | `skills/providers/<provider>/SKILL.md` |

Templates are excluded from nothing — they compile under `npm run typecheck`
and the adapter one runs under `npm test`. Keep them that way; a template that
stops compiling is a contract change nobody propagated.

**Naming.** Directories and files are `snake_case` for provider/model names
(`nano_banana.ts`, `video_broll/`), matching the `provider_t` enum values
exactly. Templates are prefixed `_`.

---

## Adding a new provider

The end-to-end path, in dependency order. Steps 1–3 are research and
plumbing; nothing works until step 6.

**1. Research it first — `skills/providers/<provider>/SKILL.md`.**
Copy the SKILL.md template. Write down capabilities, prompting, async shape
and rates *with sources* before writing code. Every number in the adapter
should be traceable back to a line here.

**2. Enum + migration.**
Add the value to `PROVIDERS` in [`src/lib/db/enums.ts`](../src/lib/db/enums.ts)
and add a migration:

```sql
alter type provider_t add value if not exists '<provider>';
```

Postgres will not let a new enum value be **used** in the same transaction
that adds it, so the `alter type` goes in its own migration file, separate
from any insert that references it. `0010_music_generation.sql` says this in
its own header; follow it.

**3. Config — `src/adapters/config.ts`.**
Add `<PROVIDER>_CONFIG` with model ids, base URL and tuning knobs. Use a
getter for anything env-derived (a plain property is read at module load,
which in Next can be before env vars exist). Add any new env var to
`.env.example`.

**4. The adapter — `src/adapters/<category>/<provider>.ts`.**
Copy `_template/adapter.ts`. Declare real capabilities, not a safe subset:
`supports_end_frame` alone decides whether end images get generated and paid
for. Multi-model adapters get a sibling `<provider>Capabilities.ts` table
(see `veoCapabilities.ts`) — never flatten several models to a lowest common
denominator.

**5. Prompt handling — `src/skills/model-prompt/<model>.ts`.**
Copy the model-prompt template. One file per **model**, not per provider.
Register it in `targetModelFor()` *and* `labelForModelId()` in
[`guidance.ts`](../src/skills/model-prompt/guidance.ts) — forgetting the
second one is the usual miss, and it only shows up as a raw model id in a
staleness warning after someone switches models.

**6. Register — `src/adapters/registry.ts`.**
Add the dynamic import and the factory call in `getDefaultAdapterRegistry()`.
Keep it lazy: importing the registry must not construct SDK or Supabase
clients eagerly. **Until this step the adapter is dead code.**

**7. Rates — a seed migration.**
Add `rate_card` rows. If the rate varies by tier/resolution, the `variant`
string must match exactly what the adapter emits (Veo composes
`<tier>@<resolution>`). A mismatch does not throw — it silently reports
`rate_missing`. If the rate genuinely is not public, leave it unseeded on
purpose and note why, as `0004` does for Higgsfield.

**8. Keys — only if shared.** If the provider reuses an existing key (Nano
Banana / Veo / Lyria all take the client's one Google key), add it to
`GOOGLE_BACKED_PROVIDERS` in [`vault.ts`](../src/lib/crypto/vault.ts) so
adapters never learn about the duplication.

**9. Selectability — only if the user picks it.** A per-reel choice needs a
label map (`src/lib/brollModels.ts` is the pattern), the zod enum on the
stage input, and the dropdown. Derive the allowed aspect ratios / resolutions
from `capabilities()` — never a hardcoded list that only fails on save.

**10. Tests.** Copy `_template/adapter.test.ts`. Cover `capabilities()`,
every `validate()` violation and warning, `estimate()` (including that no
provider call happens), and `generate()` with the SDK or `fetch` mocked.

**11. Webhook — only if the provider posts back.** Add
`app/api/webhooks/<provider>/route.ts`, authenticate the per-job
`callback_token` **before** parsing, and let the route persist and cost-log.
`parseWebhook()` is synchronous and cannot do I/O; it returns a passthrough
URL by design.

### Adding a model to an *existing* adapter

Cheaper — steps 1, 3, 5, 7 only, plus the variant capability row:

- a variant value in `src/lib/db/enums.ts` (+ migration) if the user selects it
- a model id in the provider's config block
- a row in the `<provider>Capabilities.ts` table
- its own `<model>.ts` guidance, registered in `guidance.ts`
- rate rows for the new variant string
- a label in the selector map

`0013_omni_variant.sql` plus the `omni` branch in `veo.ts` is the worked
example — a fourth model behind an existing adapter, with no orchestration
change.

---

## Adding a runtime skill

Copy `src/skills/_template.skill.ts`. Register in three places in
[`src/skills/types.ts`](../src/skills/types.ts): the input/output types, the
`SkillRegistry` method, and the bound closure in `createSkillRegistry()`.

The registry deliberately hides `onUsage` and `model` from call sites — that
is what makes it impossible for a stage to forget to bill an LLM call or to
override the reel's orchestrator model. Never hardcode a model id in a skill.

To add a selectable **orchestrator** model instead, edit
`src/lib/orchestratorModels.ts` (value, label, provider mapping) and seed its
token rates — `0015_seed_gemini_llm_rate_card.sql` is the example. A new LLM
*vendor* also needs a client and a `complete*()` function in `skills/llm.ts`.

---

## Adding a stage

Copy `src/stages/_template/index.ts`. A new stage means a `stage_t` enum
migration, a position in `STAGE_ORDER`, a route handler, and a page. Copy the
`review` hooks from `src/stages/image/index.ts` — the reference implementation
for two-granularity (prompt + asset) review. `redoAsset` must return a
redacted `PublicJob`, never a raw `Job` (which carries `callback_token` and
`payload`).

## Adding a job

Copy `src/lib/jobs/_template.ts` — but read its header first. Jobs run
**inline**; the table is an audit record, not a queue. A provider-async
render usually needs **no new handler at all**: implement `poll()` on the
adapter and `reconcile.ts` handles it generically.

---

## Verifying

```bash
npm run typecheck && npm test
```

Run `npm run typecheck` as you go rather than once at the end — the templates
are type-checked too, so a contract change surfaces immediately instead of
compounding.
