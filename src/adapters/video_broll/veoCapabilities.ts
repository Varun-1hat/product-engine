/**
 * Per-model constraints for the four Google b-roll models the veo adapter
 * fronts — model-level, not a lowest-common-denominator set, so each model is
 * used to its own limits and only its own drawbacks are worked around:
 *   - Veo 3.1 / 3.1 Fast: 4/6/8s, 720p+1080p (1080p is 8s-only), last-frame
 *     interpolation, so continuity boundaries and end images are available.
 *   - Veo 3.1 Lite: same durations/resolutions, but no last-frame
 *     interpolation — no end image is generated or sent.
 *   - Gemini Omni Flash (preview): 720p only, no duration control and no last
 *     frame; clip length is whatever the model returns and Stage 6 trims it.
 *
 * Kept free of SDK/storage imports so the setup UI can read the same table the
 * adapter validates against (one source of truth, no client-side mirror).
 */
import { VEO_VARIANTS, type VeoVariant } from "@/src/lib/db/enums";
import type { AdapterCapabilities } from "../types";

export function isVeoVariant(value: string | undefined): value is VeoVariant {
  return (VEO_VARIANTS as readonly string[]).includes(value ?? "");
}

const VEO_31: AdapterCapabilities = {
  category: "video_broll",
  provider: "veo",
  min_duration_s: 4,
  max_duration_s: 8,
  supported_durations_s: [4, 6, 8],
  supported_aspect_ratios: ["16:9", "9:16"],
  supported_resolutions: ["720p", "1080p"],
  full_duration_only_resolutions: ["1080p"],
  max_reference_images: 2, // start + end frame
  supports_end_frame: true,
  supports_duration_control: true,
  emits_audio: true,
  accepted_inputs: ["prompt", "start_image", "end_image"],
  async: true,
  billing_unit: "second",
};

export const VEO_VARIANT_CAPABILITIES: Record<VeoVariant, AdapterCapabilities> = {
  standard: VEO_31,
  fast: VEO_31,
  lite: {
    ...VEO_31,
    max_reference_images: 1,
    supports_end_frame: false,
    accepted_inputs: ["prompt", "start_image"],
  },
  omni: {
    category: "video_broll",
    provider: "veo",
    supported_aspect_ratios: ["16:9", "9:16"],
    supported_resolutions: ["720p"],
    max_reference_images: 1,
    supports_end_frame: false,
    supports_duration_control: false,
    emits_audio: true,
    accepted_inputs: ["prompt", "start_image"],
    async: true,
    billing_unit: "second",
  },
};

/** Capabilities of the model actually selected; defaults to the fast tier. */
export function veoCapabilitiesFor(variant: string | undefined): AdapterCapabilities {
  return VEO_VARIANT_CAPABILITIES[isVeoVariant(variant) ? variant : "fast"];
}
