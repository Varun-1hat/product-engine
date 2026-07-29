/**
 * Display labels for the selectable Google b-roll models (reel_config.veo_variant
 * -> model id in src/adapters/config.ts VEO_CONFIG.models). Higgsfield/OpenArt
 * stay unselectable (deferred).
 */
import { ASPECT_RATIOS, RESOLUTIONS, type VeoVariant } from "@/src/lib/db/enums";
import { veoCapabilitiesFor } from "@/src/adapters/video_broll/veoCapabilities";

export const VEO_VARIANT_LABELS: Record<VeoVariant, string> = {
  standard: "Veo 3.1",
  fast: "Veo 3.1 Fast",
  lite: "Veo 3.1 Lite (no end frame)",
  omni: "Gemini Omni Flash (preview, 720p, no end frame)",
};

/**
 * What the *selected* b-roll model can render, read straight off the adapter's
 * capability table — so the setup form only offers combinations that model
 * supports (Omni is 720p-only, Veo also does 1080p) instead of a generic list
 * that only fails on save.
 */
export function allowedAspectRatios(veoVariant: string | null | undefined): readonly string[] {
  if (!veoVariant) return ASPECT_RATIOS;
  const caps = veoCapabilitiesFor(veoVariant);
  return ASPECT_RATIOS.filter((ar) => caps.supported_aspect_ratios.includes(ar));
}

export function allowedResolutions(veoVariant: string | null | undefined): readonly string[] {
  if (!veoVariant) return RESOLUTIONS;
  const caps = veoCapabilitiesFor(veoVariant);
  return RESOLUTIONS.filter((r) => caps.supported_resolutions.includes(r));
}
