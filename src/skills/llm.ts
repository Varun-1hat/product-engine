/**
 * Claude client for the runtime skills (brief §9). Agency-level
 * ANTHROPIC_API_KEY.
 *
 * These calls ARE billed and ARE written to cost_log (this retires the
 * original Assumption 8, "agency overhead, never logged"): every call
 * reports its token usage through `onUsage`, and src/lib/context.ts turns
 * that into cost_log rows so a reel's spend covers prompt generation and
 * orchestration, not just the media providers.
 *
 * Server/worker-only by code-organization convention (see
 * src/lib/supabase/service.ts for why `server-only` is not used here —
 * this module must also run under Vitest and the tsx-run worker).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (runtime skills LLM, agency-level env)");
  client = new Anthropic({ apiKey });
  return client;
}

export interface LlmUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/** Receives one report per billed API call — including retried attempts, which cost real tokens. */
export type LlmUsageSink = (usage: LlmUsage) => void | Promise<void>;

export interface CallLlmJsonOptions<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxRetries?: number;
  model?: string;
  maxTokens?: number;
  onUsage?: LlmUsageSink;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`No JSON object found in LLM response: ${trimmed.slice(0, 200)}`);
  }
}

/**
 * Calls Claude, asks for a single JSON object, zod-validates it, retries
 * (default <=3) on parse/validation failure, then surfaces the last error
 * (spec §5: "Zod-validated output; retry <=3 then surface").
 */
export async function callLlmJson<T>(opts: CallLlmJsonOptions<T>): Promise<T> {
  const anthropic = getClient();
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  const maxRetries = opts.maxRetries ?? 3;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 2048,
        system: `${opts.system}\n\nRespond with ONLY a single JSON object — no prose, no markdown code fences.`,
        messages: [{ role: "user", content: opts.prompt }],
      });

      // Reported per attempt (a retry is a second billed call), and before
      // parsing — the tokens are spent whether or not the JSON validates.
      // Never let a bookkeeping failure fail the generation itself.
      if (opts.onUsage) {
        try {
          await opts.onUsage({
            model,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          });
        } catch {
          // ignore — cost logging must not break the pipeline
        }
      }

      const textParts: string[] = [];
      for (const block of response.content) {
        if (isTextBlock(block)) textParts.push(block.text);
      }
      const text = textParts.join("\n");

      return opts.schema.parse(extractJson(text));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`callLlmJson failed after ${maxRetries} attempts: ${String(lastError)}`);
}
