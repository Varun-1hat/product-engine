import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Route handlers stream provider webhook payloads (HeyGen) and drive
  // long-running job orchestration; keep body parsing defaults but allow
  // slightly larger payloads for base64 reference images.
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  // Job handlers (src/lib/jobs/*) now run inside route handlers. These three
  // can't be webpack-bundled: @resvg/resvg-js is a native .node addon,
  // ffmpeg-static resolves a path to a platform binary, and fluent-ffmpeg
  // requires modules dynamically. Load them from node_modules at runtime.
  //
  // `ws` (+ @google/genai, whose Node build requires it for Lyria's realtime
  // music websocket) is here for a subtler reason: ws optionally requires the
  // native `bufferutil`, expecting the require to THROW when it isn't
  // installed so it can fall back to its pure-JS mask(). Bundled, that require
  // resolves to an empty stub instead of throwing, so ws overwrites mask()
  // with a call to the non-existent bufferUtil.mask ("bufferUtil.mask is not
  // a function" on the first frame sent).
  serverExternalPackages: [
    "@resvg/resvg-js",
    "ffmpeg-static",
    "fluent-ffmpeg",
    "ws",
    "@google/genai",
  ],
  // src/lib/jobs/endframe.ts reads this .ttf at runtime (satori needs a real
  // font file); it's a plain fs.readFile off process.cwd(), so nothing traces
  // it automatically.
  //
  // KNOWN GAP, only relevant if this ever moves to `output: "standalone"` or
  // a traced serverless deploy (it is NOT today — `next build && next start`
  // has the full node_modules on disk): ffmpeg-static reads its binary's
  // NAME out of its own package.json at require time, so the tracer records
  // index.js + package.json and never the ffmpeg executable itself. Includes
  // under node_modules are ignored here, so the fix at that point is to copy
  // node_modules/ffmpeg-static/ffmpeg* into the deploy artifact, or set
  // FFMPEG_PATH / ship ffmpeg in the image instead.
  outputFileTracingIncludes: {
    "/api/reels/**": ["./src/lib/jobs/assets/fonts/**"],
  },
};

export default nextConfig;
