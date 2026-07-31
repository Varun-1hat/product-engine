/**
 * Lyria (Google) — music adapter (spec §3.4), the Google-model counterpart
 * to the ElevenLabs one. Lyria is a *realtime* model: `ai.live.music` streams
 * raw PCM chunks over a websocket rather than returning a finished file, so
 * generate() collects chunks until the requested length is covered, stops the
 * session, wraps the PCM in a WAV container and persists it to `music/`.
 * Uses the client's Google key (same key as Nano Banana/Veo — see vault.ts).
 */
import { GoogleGenAI } from "@google/genai";
import type { Adapter, AdapterCapabilities, EstimateInput, GenerateInput, GenerateResult, ValidationResult } from "../types";
import { LYRIA_CONFIG } from "../config";
import { buildGeneratedPath, type StorageClient } from "@/src/lib/storage";

const CAPABILITIES: AdapterCapabilities = {
  category: "music",
  provider: "lyria",
  // Lyria streams in realtime, so the capture is bounded by how long we're
  // willing to hold the session open (LYRIA_CONFIG.timeoutMs) rather than by
  // a model-side maximum.
  min_duration_s: 5,
  max_duration_s: Math.floor(LYRIA_CONFIG.timeoutMs / 1000),
  supported_aspect_ratios: [],
  supported_resolutions: [],
  accepted_inputs: ["prompt"],
  async: false,
  billing_unit: "second",
};

function validateInput(input: Partial<GenerateInput>): ValidationResult {
  const violations: string[] = [];
  if (!input.prompt || !input.prompt.trim()) violations.push("prompt is required");
  return { ok: violations.length === 0, violations, warnings: [] };
}

/** Minimal 44-byte RIFF/WAVE header for the 16-bit PCM Lyria streams. */
function wavFromPcm(pcm: Buffer): Buffer {
  const { sampleRate, channels } = LYRIA_CONFIG;
  const byteRate = sampleRate * channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createLyriaAdapter(deps: { storage: StorageClient }): Adapter {
  const { storage } = deps;

  /** Streams `seconds` worth of PCM from a Lyria session. */
  async function streamPcm(prompt: string, seconds: number, apiKey: string): Promise<Buffer> {
    const targetBytes = Math.ceil(seconds * LYRIA_CONFIG.sampleRate) * LYRIA_CONFIG.channels * 2;
    const chunks: Buffer[] = [];
    let collected = 0;

    const ai = new GoogleGenAI({ apiKey, apiVersion: LYRIA_CONFIG.apiVersion });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("lyria: timed out waiting for audio")), LYRIA_CONFIG.timeoutMs);
      let close: () => void = () => {};

      function finish(err?: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        close();
        if (err) reject(err);
        else resolve();
      }

      ai.live.music
        .connect({
          model: LYRIA_CONFIG.model,
          callbacks: {
            onmessage: (message) => {
              const data = message.serverContent?.audioChunks?.[0]?.data;
              if (!data) return;
              const buf = Buffer.from(data, "base64");
              chunks.push(buf);
              collected += buf.length;
              if (collected >= targetBytes) finish();
            },
            onerror: (e) => finish(new Error(`lyria stream error: ${String((e as ErrorEvent).message ?? e)}`)),
            onclose: () => finish(collected > 0 ? undefined : new Error("lyria: stream closed before any audio")),
          },
        })
        .then(async (session) => {
          close = () => {
            session.stop();
            session.close();
          };
          await session.setWeightedPrompts({ weightedPrompts: [{ text: prompt, weight: 1 }] });
          await session.setMusicGenerationConfig({ musicGenerationConfig: {} });
          session.play();
        })
        .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
    });

    return Buffer.concat(chunks).subarray(0, targetBytes);
  }

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`lyria validate() failed: ${validation.violations.join("; ")}`);
    }

    const seconds = input.duration_s ?? LYRIA_CONFIG.defaultDurationS;
    const wav = wavFromPcm(await streamPcm(input.prompt, seconds, input.provider_key));

    const path = buildGeneratedPath({
      client_id: input.client_id,
      reel_id: input.reel_id,
      idempotency_key: input.idempotency_key,
      ext: "wav",
    });
    await storage.upload("music", path, wav, "audio/wav");

    return {
      status: "succeeded",
      asset: {
        storage_path: path,
        mime: "audio/wav",
        metadata: { width: 0, height: 0, aspect: "", resolution: "", duration_s: seconds },
      },
      units: seconds,
      unit_type: "second",
      raw: { model: LYRIA_CONFIG.model },
    };
  }

  return {
    id: "lyria@1",
    category: "music",
    provider: "lyria",
    capabilities: () => CAPABILITIES,
    validate: validateInput,
    estimate(input: EstimateInput) {
      return { units: input.duration_s ?? LYRIA_CONFIG.defaultDurationS, unit_type: "second" };
    },
    generate,
  };
}
