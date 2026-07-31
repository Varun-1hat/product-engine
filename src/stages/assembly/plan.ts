/**
 * Stage 9 assembly-plan construction (spec §7 Stage 9) — pure, no I/O, no
 * ffmpeg. src/lib/jobs/assembly.ts turns this plan into actual ffmpeg commands;
 * everything about WHICH clips, in WHAT order, which seams get the 1-frame
 * trim, and the music timing math lives here so it's independently
 * unit-testable without ffmpeg or real media files.
 *
 * Steps encoded (§7 Stage 9 / §8 / §10.9-10.11 / §10.20):
 *  1. Ordered clip list = scenes by position (their clip_asset_id current
 *     version) + the outro clip appended last.
 *  2. (inline) strip audio + normalize every clip to reel resolution/
 *     aspect_ratio/output_fps/yuv420p/H.264. The picture lane is always
 *     silent: a model's native audio travels as its own `clip_audio` asset
 *     (src/lib/clipAudio.ts) so it can be switched off, replaced or cut
 *     separately, and it is mixed back in at step 5 — muxing it here would
 *     make the seam trim in step 3 shift the sound along with the picture.
 *  3. Continuous-seam 1-frame trim: for each adjacent pair whose
 *     *effective* boundary is 'continuous', drop 1 frame from the head of
 *     the INCOMING clip. Hard-cut boundaries: no trim. The outro's
 *     incoming boundary is never a shared-frame seam.
 *  4. (inline) concat the normalized clips.
 *  5. Audio: a clip-audio lane (each enabled track fitted to its own clip's
 *     post-normalize length, silence where a clip has none) mixed with the
 *     music bed (trimmed/looped to the reel + fade in/out, ducked under the
 *     clip audio when there is any). Either lane alone is used as-is.
 *  6. (inline) mux to mp4 (H.264 + AAC) -> renders/ -> a new final_render
 *     asset_version.
 */
import { effectiveBoundary, type ReelConfigLike, type SceneLike, type SupportsEndFrameLookup } from "@/src/lib/routing";

export interface AssemblyClipPlan {
  scene_id: string | null; // null for the outro clip
  role: "scene" | "outro";
  storage_path: string;
  /** Drop 1 frame from the head of this clip — it's the incoming side of a continuous seam (§10.11). */
  trim_head_frame: boolean;
  /**
   * This clip's expected length from scene metadata. The job measures the real
   * post-normalize length instead, and only falls back to this if that probe
   * comes back empty — probeDurationS reads ffmpeg's `codecData` (there is no
   * ffprobe binary) and can legitimately yield 0, which would otherwise
   * collapse this clip's audio segment and shift everything after it.
   */
  duration_s: number;
  /**
   * This clip's own audio track (src/lib/clipAudio.ts), or null when the model
   * emitted none or the user switched it off. Carried as a separate file
   * rather than left inside `storage_path` because the picture is still
   * audio-stripped on normalize — the two are cut, toggled and mixed
   * independently.
   */
  audio_storage_path: string | null;
}

export interface MusicPlan {
  storage_path: string;
  start_s: number;
  end_s: number;
  /** The trimmed segment is shorter than the reel — loop it to cover total_duration_s. */
  loop: boolean;
  fade_in_s: number;
  fade_out_s: number;
  /** Level to mix the bed in at — ducked under the clips' own audio when any of it is playing. */
  volume: number;
}

/**
 * Music is a *background* bed: when the clips carry their own audio it sits
 * under them rather than competing. With no clip audio anywhere it is the only
 * thing playing, so it runs at full level exactly as it always did.
 */
export const MUSIC_VOLUME_UNDER_CLIP_AUDIO = 0.35;

export interface AssemblyPlan {
  clips: AssemblyClipPlan[];
  aspect_ratio: string;
  resolution: string;
  fps: number;
  total_duration_s: number;
  music: MusicPlan | null;
  output_path: string;
}

export interface AssemblyMusicSource {
  storage_path: string;
  music_trim: { start_s: number; end_s: number } | null;
  /** Duration of the source file on disk, if probed — used only when music_trim has no end_s. */
  source_duration_s?: number;
}

export interface BuildAssemblyPlanParams {
  /** Ordered by position. */
  scenesByPosition: SceneLike[];
  /** scene_id -> current (trimmed) clip storage_path. Every scene here MUST have one. */
  clipStoragePaths: Record<string, string>;
  /** scene_id -> the scene's (post-trim) duration in seconds, for total-duration/music math. */
  sceneDurations: Record<string, number>;
  outroClipStoragePath: string;
  outroSeconds: number;
  reelConfig: ReelConfigLike;
  aspectRatio: string;
  resolution: string;
  fps: number;
  supportsEndFrame: SupportsEndFrameLookup;
  music: AssemblyMusicSource | null;
  /** scene_id -> that clip's enabled audio track. Absent = silent in the mix. */
  clipAudioPaths?: Record<string, string>;
  /** The outro clip's enabled audio track, if any. */
  outroAudioPath?: string | null;
  outputPath: string;
  /** Default 1.5s, capped at half the total duration for very short reels. */
  fadeSeconds?: number;
}

function buildMusicPlan(
  source: AssemblyMusicSource,
  totalDurationS: number,
  fadeSeconds: number,
  volume: number
): MusicPlan {
  const start = source.music_trim?.start_s ?? 0;
  const end = source.music_trim?.end_s ?? source.source_duration_s ?? start + totalDurationS;
  const trimmedLength = Math.max(0.001, end - start);
  const loop = trimmedLength < totalDurationS;
  const fade = Math.min(fadeSeconds, totalDurationS / 2);
  return { storage_path: source.storage_path, start_s: start, end_s: end, loop, fade_in_s: fade, fade_out_s: fade, volume };
}

export function buildAssemblyPlan(params: BuildAssemblyPlanParams): AssemblyPlan {
  const clips: AssemblyClipPlan[] = [];

  for (let i = 0; i < params.scenesByPosition.length; i++) {
    const scene = params.scenesByPosition[i];
    const storagePath = params.clipStoragePaths[scene.id];
    if (!storagePath) {
      throw new Error(`assembly: scene ${scene.id} (position ${scene.position}) has no clip storage_path`);
    }

    const prev = params.scenesByPosition[i - 1] ?? null;
    const trimHead = prev
      ? effectiveBoundary(prev, scene, params.reelConfig, params.supportsEndFrame) === "continuous"
      : false;

    clips.push({
      scene_id: scene.id,
      role: "scene",
      storage_path: storagePath,
      trim_head_frame: trimHead,
      duration_s: params.sceneDurations[scene.id] ?? 0,
      audio_storage_path: params.clipAudioPaths?.[scene.id] ?? null,
    });
  }

  // The outro's incoming boundary is never a shared-frame continuous seam
  // (it either chains via its own end-frame-capable model or a
  // deterministic crossfade — §7 Stage 7) — never trim its head frame.
  clips.push({
    scene_id: null,
    role: "outro",
    storage_path: params.outroClipStoragePath,
    trim_head_frame: false,
    duration_s: params.outroSeconds,
    audio_storage_path: params.outroAudioPath ?? null,
  });

  const scenesTotal = params.scenesByPosition.reduce((sum, s) => sum + (params.sceneDurations[s.id] ?? 0), 0);
  const totalDurationS = scenesTotal + params.outroSeconds;

  const hasClipAudio = clips.some((clip) => clip.audio_storage_path);
  const music = params.music
    ? buildMusicPlan(
        params.music,
        totalDurationS,
        params.fadeSeconds ?? 1.5,
        hasClipAudio ? MUSIC_VOLUME_UNDER_CLIP_AUDIO : 1
      )
    : null;

  return {
    clips,
    aspect_ratio: params.aspectRatio,
    resolution: params.resolution,
    fps: params.fps,
    total_duration_s: totalDurationS,
    music,
    output_path: params.outputPath,
  };
}

export type { ReelConfigLike, SceneLike, SupportsEndFrameLookup };
