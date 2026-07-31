/**
 * Generic client-scoped file upload (spec §7.1) — logo / music /
 * end-frame uploads all funnel through this one endpoint so every
 * caller (ConfigBrandTab's logo, Outro's custom end-frame, Music's track)
 * shares the same multipart parsing + path-building instead of each owning
 * its own. Bucket + path come from the *existing* helpers in
 * src/lib/storage/index.ts (buildClientPath/buildGeneratedPath) — no new
 * path scheme invented here. Sits behind Phase 0's middleware like every
 * other route; no extra auth logic needed.
 */
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildConfigContext } from "@/src/lib/context";
import { buildClientPath, buildGeneratedPath, type BucketName } from "@/src/lib/storage";

const UPLOAD_KINDS = ["logo", "music", "end_frame", "asset"] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

function isUploadKind(value: FormDataEntryValue | null): value is UploadKind {
  return typeof value === "string" && (UPLOAD_KINDS as readonly string[]).includes(value);
}

/** Prefer the uploaded filename's extension; fall back to the mime subtype (e.g. "image/png" -> "png"). */
function extFromFile(file: File): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop() : undefined;
  if (fromName) return fromName.toLowerCase();
  const fromMime = file.type.split("/").pop();
  return fromMime ? fromMime.toLowerCase() : "bin";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const kind = form.get("kind");
  const reelIdField = form.get("reel_id");
  const reelId = typeof reelIdField === "string" && reelIdField.length > 0 ? reelIdField : undefined;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!isUploadKind(kind)) {
    return NextResponse.json({ error: `kind must be one of: ${UPLOAD_KINDS.join(", ")}` }, { status: 400 });
  }
  if ((kind === "music" || kind === "end_frame" || kind === "asset") && !reelId) {
    return NextResponse.json({ error: `reel_id is required for kind "${kind}"` }, { status: 400 });
  }

  const ext = extFromFile(file);
  const ctx = buildConfigContext(clientId);

  let bucket: BucketName;
  let path: string;
  switch (kind) {
    case "logo":
      bucket = "brand";
      path = buildClientPath({ client_id: clientId, category: "logo", file_id: randomUUID(), ext });
      break;
    case "music":
      bucket = "music";
      path = buildClientPath({ client_id: clientId, category: `reels/${reelId!}/music`, file_id: randomUUID(), ext });
      break;
    case "end_frame":
    // A user-supplied override for any generated image/clip slot — lands in
    // the same bucket/path scheme as a generated asset, since it becomes a
    // plain `uploaded` version of that asset (see uploadAssetVersion).
    case "asset":
      bucket = "assets";
      path = buildGeneratedPath({ client_id: clientId, reel_id: reelId!, idempotency_key: randomUUID(), ext });
      break;
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await ctx.storage.upload(bucket, path, buffer, file.type || "application/octet-stream");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  return NextResponse.json({ storage_path: path });
}
