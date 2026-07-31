# product-engine

AI product-video pipeline: adapter-centric, human-reviewed reel generation.

Fixed stage order — `reel_setup → scene → image → clip → trim → outro → music
→ assembly`. Which scenes and clip types are included varies by config; the
order never does.

## Start here

**[docs/architecture.md](docs/architecture.md)** — the layer map, the
invariants that keep provider additions cheap, and the ordered checklist for
adding a new model, provider, skill, stage or job.

Every extensible file type has a copy-from template (`_template*`) that is
real, compiled, tested code. Copy the template, not a neighbouring
implementation — templates carry the reasoning and the traps.

## Commands

```bash
npm run dev        # next dev
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```
