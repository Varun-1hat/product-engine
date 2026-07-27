/**
 * Shared fluent-ffmpeg configuration — points it at the ffmpeg-static
 * binary once. Imported by worker/trim.ts and worker/assembly.ts.
 */
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

export default ffmpeg;
