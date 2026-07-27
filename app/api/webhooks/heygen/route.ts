/**
 * HeyGen webhook receiver (spec §3.1/§14.3, brief §10.19): events
 * `avatar_video.success` / `avatar_video.fail`. Authenticated via the
 * per-job `callback_token` query param set when Stage 5 built the
 * callback_url (src/adapters/config.ts heygenCallbackUrl) — the job row is
 * looked up by that token, never trusted from the payload body alone.
 *
 * heygenAdapter.parseWebhook() is synchronous/no-I/O (spec §3 — it cannot
 * upload to Storage itself), returning a passthrough `asset.url`; this
 * route handler (which has full job context from the callback_token
 * lookup) downloads it and persists the asset_version + cost_log, mirroring
 * the same "reconcile poll()'s best-effort result against jobs.payload"
 * pattern as worker/reconcile.ts (see that file's header note).
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/src/lib/supabase/service";
import { createStorageClient, buildPollResultPath } from "@/src/lib/storage";
import { createJobQueue, type Job } from "@/src/lib/jobs/queue";
import { createCostEngine } from "@/src/lib/cost/engine";
import { getDefaultAdapterRegistry } from "@/src/adapters/registry";
import { getAsset, upsertAssetVersion } from "@/src/lib/versioning";
import { dimensionsFor } from "@/src/adapters/dimensions";
import type { Provider } from "@/src/lib/db/enums";

interface AvatarGenJobPayload {
  call_type?: "generate" | "redo";
  units?: number;
  unit_type?: string;
  aspect_ratio?: string;
  resolution?: string;
  duration_s?: number | null;
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing callback token" }, { status: 401 });

  const supa = createServiceClient();
  const { data: jobRow, error: jobError } = await supa
    .from("jobs")
    .select("*")
    .eq("callback_token", token)
    .maybeSingle();
  if (jobError) return NextResponse.json({ error: jobError.message }, { status: 500 });
  if (!jobRow) return NextResponse.json({ error: "unknown or expired callback token" }, { status: 401 });
  const job = jobRow as Job;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid JSON payload" }, { status: 400 });

  const adapters = await getDefaultAdapterRegistry();
  const adapter = adapters.get("video_avatar", "heygen");
  if (!adapter.parseWebhook) {
    return NextResponse.json({ error: "heygen adapter has no parseWebhook" }, { status: 500 });
  }

  const jobs = createJobQueue(supa);
  const costEngine = createCostEngine(supa);
  const payload = (job.payload ?? {}) as AvatarGenJobPayload;

  if (!job.reel_id) {
    return NextResponse.json({ error: `job ${job.id} has no reel_id` }, { status: 500 });
  }
  const { data: reelRow, error: reelError } = await supa.from("reels").select("client_id").eq("id", job.reel_id).single();
  if (reelError) return NextResponse.json({ error: reelError.message }, { status: 500 });
  const clientId = (reelRow as { client_id: string }).client_id;

  let parsed: ReturnType<NonNullable<typeof adapter.parseWebhook>>;
  try {
    parsed = adapter.parseWebhook(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  const callType = payload.call_type ?? "generate";

  if (parsed.status === "failed") {
    await costEngine.log({
      reel_id: job.reel_id,
      client_id: clientId,
      scene_id: job.scene_id ?? undefined,
      stage: "clip",
      provider: "heygen",
      adapter: adapter.id,
      call_type: callType,
      call_status: parsed.billed ? "failed_billed" : "failed_unbilled",
      provider_asset_id: parsed.provider_job_id,
      idempotency_key: job.idempotency_key ?? undefined,
    });
    await jobs.fail(job.id, "heygen webhook reported avatar_video.fail");
    return NextResponse.json({ ok: true });
  }

  if (!parsed.asset?.url) {
    return NextResponse.json({ error: "webhook reported success but no asset url was present" }, { status: 400 });
  }
  if (!job.asset_id) {
    return NextResponse.json({ error: `job ${job.id} has no asset_id` }, { status: 500 });
  }

  const downloaded = await fetch(parsed.asset.url);
  if (!downloaded.ok) {
    return NextResponse.json({ error: `failed to download rendered video (${downloaded.status})` }, { status: 502 });
  }
  const buffer = Buffer.from(await downloaded.arrayBuffer());
  const mime = downloaded.headers.get("content-type") ?? parsed.asset.mime ?? "video/mp4";
  const ext = mime.split("/")[1] ?? "mp4";

  const storage = createStorageClient(supa);
  const destPath = buildPollResultPath({ provider: "heygen", provider_job_id: parsed.provider_job_id, ext });
  await storage.upload("assets", destPath, buffer, mime);

  const asset = await getAsset(supa, job.asset_id);
  const aspectRatio = payload.aspect_ratio ?? "9:16";
  const resolution = payload.resolution ?? "1080p";
  const { width, height } = dimensionsFor(aspectRatio, resolution);

  const costLog = await costEngine.log({
    reel_id: job.reel_id,
    client_id: clientId,
    scene_id: job.scene_id ?? undefined,
    stage: "clip",
    provider: "heygen",
    adapter: adapter.id,
    call_type: callType,
    call_status: "success",
    units: payload.units ?? parsed.units ?? 1,
    unit_type: payload.unit_type ?? parsed.unit_type ?? "video",
    provider_asset_id: parsed.provider_job_id,
    idempotency_key: job.idempotency_key ?? undefined,
  });

  const { version } = await upsertAssetVersion(supa, {
    assetId: job.asset_id,
    reel_id: job.reel_id,
    scene_id: job.scene_id,
    slot: asset.slot,
    media_type: "video",
    shared: asset.shared,
    storage_path: destPath,
    source: "generated",
    provider: "heygen" as Provider,
    metadata: {
      width,
      height,
      aspect: aspectRatio,
      resolution,
      duration_s: payload.duration_s ?? undefined,
      mime,
    },
    units: payload.units ?? parsed.units ?? 1,
    unit_type: payload.unit_type ?? parsed.unit_type ?? "video",
    cost_log_id: costLog.id,
  });

  await jobs.complete(job.id, { asset_version_id: version.id });
  return NextResponse.json({ ok: true });
}
