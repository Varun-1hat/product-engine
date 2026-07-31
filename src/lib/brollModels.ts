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

/** Whether the selected b-roll model can interpolate to a last frame at all. */
export function supportsEndFrame(veoVariant: string | null | undefined): boolean {
  return veoCapabilitiesFor(veoVariant ?? undefined).supports_end_frame ?? false;
}

/**
 * Whether a scene's clip call will actually carry a last frame — the client-side
 * counterpart of src/lib/routing.ts's `effectiveBoundary`/`needsEndImage`, for
 * pages that must answer this about UNSAVED editor rows and so cannot ask the
 * server. Reads `supports_end_frame` off the capability table rather than
 * hardcoding which models interpolate, so it follows a capability change the
 * same way the server-side rule does.
 *
 * Kept next to the other UI capability readers because the same rule already
 * has a home here; the composition (broll -> broll, not disabled, intent is
 * continuous) mirrors routing.ts deliberately, since routing.ts pulls in the
 * adapter config graph and is not client-importable.
 */
export function sceneUsesEndFrame(
  scene: { type: string; transition_to_next: string | null; end_frame_disabled?: boolean },
  next: { type: string } | null | undefined,
  veoVariant: string | null | undefined
): boolean {
  if (scene.type !== "broll") return false;
  if (scene.end_frame_disabled) return false;
  if (scene.transition_to_next !== "continuous") return false;
  if (!next || next.type !== "broll") return false;
  return supportsEndFrame(veoVariant);
}
