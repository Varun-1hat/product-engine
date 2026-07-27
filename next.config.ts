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
};

export default nextConfig;
