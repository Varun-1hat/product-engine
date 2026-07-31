/**
 * Orchestrating-LLM client for the runtime skills (brief §9). Claude or Gemini,
 * picked per reel via reel_config.orchestrator_model (src/lib/orchestratorModels.ts)
 * and threaded in by src/lib/context.ts. Agency-level keys: ANTHROPIC_API_KEY /
 * GEMINI_API_KEY.
 *
 * These calls ARE billed and ARE written to cost_log (this retires the
 * original Assumption 8, "agency overhead, never logged"): every call
 * reports its token usage through `onUsage`, and src/lib/context.ts turns
 * that into cost_log rows so a reel's spend covers prompt generation and
 * orchestration, not just the media providers.
 *
 * Server-only by code-organization convention (see
 * src/lib/supabase/service.ts for why `server-only` is not used here —
 * this module must also run under Vitest).
 */
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { z } from "zod";
import { DEFAULT_ORCHESTRATOR_MODEL, providerForOrchestratorModel } from "@/src/lib/orchestratorModels";

let client: Anthropic | null = null;
let geminiClient: GoogleGenAI | null = null;

/** `clientKey` = the client's own orchestrator key (src/lib/context.ts); absent falls back to the agency env key. */
function getClient(clientKey?: string): Anthropic {
  if (clientKey) return new Anthropic({ apiKey: clientKey });
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (runtime skills LLM, agency-level env)");
  client = new Anthropic({ apiKey });
  return client;
}

function getGeminiClient(clientKey?: string): GoogleGenAI {
  if (clientKey) return new GoogleGenAI({ apiKey: clientKey });
  if (geminiClient) return geminiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY (runtime skills LLM, agency-level env)");
  geminiClient = new GoogleGenAI({ apiKey });
  return geminiClient;
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
  /** The client's own orchestrator key; omitted = the agency-level env key. */
  apiKey?: string;
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

interface RawCompletion {
  text: string;
  input_tokens: number;
  output_tokens: number;
}

async function completeAnthropic(model: string, system: string, prompt: string, maxTokens: number, apiKey?: string): Promise<RawCompletion> {
  const response = await getClient(apiKey).messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });

  const textParts: string[] = [];
  for (const block of response.content) {
    if (isTextBlock(block)) textParts.push(block.text);
  }

  return {
    text: textParts.join("\n"),
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}

async function completeGemini(model: string, system: string, prompt: string, maxTokens: number, apiKey?: string): Promise<RawCompletion> {
  const response = await getGeminiClient(apiKey).models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      systemInstruction: system,
      maxOutputTokens: maxTokens,
      // Gemini's own JSON mode, on top of the shared system-prompt instruction.
      responseMimeType: "application/json",
    },
  });

  return {
    text: response.text ?? "",
    input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/**
 * Calls the reel's orchestrating LLM (Claude or Gemini — see
 * src/lib/orchestratorModels.ts), asks for a single JSON object, zod-validates
 * it, retries (default <=3) on parse/validation failure, then surfaces the last
 * error (spec §5: "Zod-validated output; retry <=3 then surface").
 */
export async function callLlmJson<T>(opts: CallLlmJsonOptions<T>): Promise<T> {
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ORCHESTRATOR_MODEL;
  const maxRetries = opts.maxRetries ?? 3;
  const maxTokens = opts.maxTokens ?? 2048;
  const system = `${opts.system}\n\nRespond with ONLY a single JSON object — no prose, no markdown code fences.`;
  const complete = providerForOrchestratorModel(model) === "gemini" ? completeGemini : completeAnthropic;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await complete(model, system, opts.prompt, maxTokens, opts.apiKey);

      // Reported per attempt (a retry is a second billed call), and before
      // parsing — the tokens are spent whether or not the JSON validates.
      // Never let a bookkeeping failure fail the generation itself.
      if (opts.onUsage) {
        try {
          await opts.onUsage({
            model,
            input_tokens: response.input_tokens,
            output_tokens: response.output_tokens,
          });
        } catch {
          // ignore — cost logging must not break the pipeline
        }
      }

      return opts.schema.parse(extractJson(response.text));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`callLlmJson failed after ${maxRetries} attempts: ${String(lastError)}`);
}
