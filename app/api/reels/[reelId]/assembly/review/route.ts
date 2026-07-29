/**
 * Assembly has no `ReviewHooks` (src/stages/assembly/index.ts exports only
 * load/process/advance — there's no prompt to edit, and "redo" for a final
 * render is the Assembly page's "Re-assemble" button, which re-POSTs
 * /api/reels/{reelId}/assembly directly rather than going through a
 * redoAsset-style hook). This route exists solely so the shared
 * `DownloadButton` component — and the Assembly page's own `<video>`
 * preview — can resolve a signed URL for the final_render asset's current
 * version, using the same `{ action: "download", assetVersionId }` ->
 * `{ url }` contract every other stage's `.../review` route uses (spec
 * §8.1's "existing DownloadButton component" + "signed URL" preview).
 * Deliberately not a full `dispatchReviewAction`/`ReviewHooks` dispatch —
 * none of the other six review actions apply to this stage.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildStageContext } from "@/src/lib/context";

const downloadActionSchema = z.object({
  action: z.literal("download"),
  assetVersionId: z.string().uuid(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = downloadActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "assembly's review endpoint only supports the 'download' action" },
      { status: 400 }
    );
  }

  const ctx = await buildStageContext(reelId);
  try {
    const { data, error } = await ctx.supa
      .from("asset_versions")
      .select("storage_path")
      .eq("id", parsed.data.assetVersionId)
      .single();
    if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);
    const storagePath = (data as { storage_path: string | null }).storage_path;
    if (!storagePath) throw new Error("this version has no storage_path yet");

    const url = await ctx.storage.signedUrl("renders", storagePath);
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
