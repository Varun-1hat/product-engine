/**
 * Shared aspect_ratio x resolution -> pixel dimensions mapping, used by the
 * image/video adapters when building asset_versions.metadata. Not part of
 * the §3 contract itself, just a small deterministic helper the wave-1
 * adapters share so a 9:16/1080p asset always reports 1080x1920, etc.
 */
export function dimensionsFor(aspectRatio: string, resolution: string): { width: number; height: number } {
  const hd = resolution === "1080p";
  switch (aspectRatio) {
    case "16:9":
      return hd ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
    case "9:16":
      return hd ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
    case "1:1":
    default:
      return hd ? { width: 1080, height: 1080 } : { width: 720, height: 720 };
  }
}
