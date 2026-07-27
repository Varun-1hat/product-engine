/**
 * Shared POST-body shape + dispatcher for the Stage 4/5/7 review routes
 * (app/api/reels/[reelId]/{image,clip,outro}/review/route.ts). Each route
 * just builds ctx, builds the stage's ctx-bound ReviewHooks (see
 * src/stages/image/index.ts header note on why review isn't a static
 * field), and calls dispatchReviewAction — no per-route duplication of the
 * action switch.
 */
import { z } from "zod";
import type { ReviewHooks } from "@/src/stages/types";

export const reviewActionSchema = z.object({
  action: z.enum(["redoPrompt", "editPrompt", "redoAsset", "revertPrompt", "revertAsset", "download", "history"]),
  promptId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  /** For 'download': an asset_versions.id (a specific version, not the asset). */
  assetVersionId: z.string().uuid().optional(),
  text: z.string().optional(),
  refs: z.array(z.string()).optional(),
  versionNo: z.number().int().optional(),
});
export type ReviewActionInput = z.infer<typeof reviewActionSchema>;

export async function dispatchReviewAction(hooks: ReviewHooks, input: ReviewActionInput): Promise<unknown> {
  switch (input.action) {
    case "redoPrompt":
      if (!input.promptId) throw new Error("promptId is required for redoPrompt");
      return hooks.redoPrompt(input.promptId);

    case "editPrompt":
      if (!input.promptId || input.text === undefined) throw new Error("promptId and text are required for editPrompt");
      return hooks.editPrompt(input.promptId, input.text, input.refs);

    case "redoAsset":
      if (!input.assetId) throw new Error("assetId is required for redoAsset");
      return hooks.redoAsset(input.assetId);

    case "revertPrompt":
      if (!input.promptId || input.versionNo === undefined) {
        throw new Error("promptId and versionNo are required for revertPrompt");
      }
      await hooks.revertPrompt(input.promptId, input.versionNo);
      return { ok: true };

    case "revertAsset":
      if (!input.assetId || input.versionNo === undefined) {
        throw new Error("assetId and versionNo are required for revertAsset");
      }
      await hooks.revertAsset(input.assetId, input.versionNo);
      return { ok: true };

    case "download":
      if (!input.assetVersionId) throw new Error("assetVersionId is required for download");
      return { url: await hooks.download(input.assetVersionId) };

    case "history":
      return { history: await hooks.history({ promptId: input.promptId, assetId: input.assetId }) };

    default:
      throw new Error(`unknown review action: ${String(input.action)}`);
  }
}
