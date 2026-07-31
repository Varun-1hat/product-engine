/**
 * Pins the injection contract of src/skills/scene-brain.ts: the selected
 * models' constraints reach the LLM, and reach it whatever the user has done to
 * the editable instruction.
 *
 * Why this specific test: `reel_config.scene_prompt` REPLACES the built-in
 * system prompt wholesale rather than extending it. So the obvious way to add
 * model constraints — writing them into SCENE_BRAIN_SYSTEM_PROMPT — silently
 * works until the first person customises their prompt, at which point every
 * constraint disappears and the scene script goes back to allocating durations
 * the model cannot honour. Appending them outside the editable text is what
 * makes that impossible, and this test is what keeps it that way.
 *
 * `callLlmJson` is mocked at the module boundary (the same posture as
 * middleware.test.ts and the webhook route test) so no API key or network call
 * is needed; the assertions are all on the `system` string it receives.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ModelConstraints } from "./model-prompt/constraints";

const callLlmJson = vi.hoisted(() => vi.fn());
vi.mock("./llm", () => ({ callLlmJson }));

import { sceneBrain, SCENE_BRAIN_SYSTEM_PROMPT } from "./scene-brain";

const CONSTRAINTS: ModelConstraints[] = [
  {
    model: "Veo 3.1 Fast",
    role: "b-roll",
    source: "https://ai.google.dev/gemini-api/docs/veo",
    verified_on: "2026-07-30",
    items: [
      {
        label: "A continuous boundary forces 8s",
        detail: "supplying a last frame renders exactly 8 seconds regardless of the requested duration.",
        severity: "forced",
      },
    ],
  },
];

/** The `system` string handed to the LLM on the most recent call. */
function systemPrompt(): string {
  return callLlmJson.mock.calls.at(-1)![0].system as string;
}

const BASE_INPUT = {
  topic: "widget",
  total_seconds_target: 20,
  avatar_enabled: false,
  brand: {},
};

beforeEach(() => {
  callLlmJson.mockResolvedValue({
    scenes: [{ type: "broll", seconds: 8, transition_to_next: null, description: "a shot" }],
  });
});

describe("sceneBrain — model constraint injection", () => {
  it("appends the constraints after the built-in instruction", async () => {
    await sceneBrain({ ...BASE_INPUT, model_constraints: CONSTRAINTS });

    const system = systemPrompt();
    expect(system).toContain(SCENE_BRAIN_SYSTEM_PROMPT);
    expect(system).toContain("A continuous boundary forces 8s");
    expect(system).toContain("Veo 3.1 Fast");
    // Order matters: the constraints have to land after the instruction, since
    // they are the premises the instruction is carried out under.
    expect(system.indexOf("A continuous boundary forces 8s")).toBeGreaterThan(system.indexOf(SCENE_BRAIN_SYSTEM_PROMPT));
  });

  // The regression this whole design exists to prevent.
  it("still appends them when the user has replaced the instruction entirely", async () => {
    await sceneBrain({
      ...BASE_INPUT,
      system_prompt: "Ignore everything else. Write five two-second scenes.",
      model_constraints: CONSTRAINTS,
    });

    const system = systemPrompt();
    expect(system).toContain("Write five two-second scenes");
    expect(system).not.toContain(SCENE_BRAIN_SYSTEM_PROMPT);
    expect(system).toContain("A continuous boundary forces 8s");
  });

  it("includes the instruction on how to spend the constraints, not just the facts", async () => {
    await sceneBrain({ ...BASE_INPUT, model_constraints: CONSTRAINTS });
    // Inform-don't-constrain: scene-brain must be told the durations are real
    // costs to reason about, not a hard cap to obey.
    expect(systemPrompt()).toContain("HOW TO USE THE CONSTRAINTS BELOW:");
  });

  it("adds nothing when no models are resolvable, leaving the prompt untouched", async () => {
    await sceneBrain({ ...BASE_INPUT, model_constraints: [] });
    expect(systemPrompt()).toBe(SCENE_BRAIN_SYSTEM_PROMPT);
  });

  it("omitting model_constraints entirely is not an error", async () => {
    await expect(sceneBrain(BASE_INPUT)).resolves.toBeTruthy();
    expect(systemPrompt()).toBe(SCENE_BRAIN_SYSTEM_PROMPT);
  });
});
