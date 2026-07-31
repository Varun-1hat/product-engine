import { defineConfig } from "vitest/config";
import path from "node:path";

// Pure-logic test config. The pipeline's testable surface (cost engine,
// effective-model routing, continuity/shared-frame lineage, adapter
// validate()/estimate(), assembly-plan construction, job-queue helpers)
// lives in framework-free src/** and src/lib/jobs/** modules, so no DOM/React
// test environment is needed here.
//
// app/**/*.test.ts is included too (added by the Tester pass): the
// app/api/** route handlers are plain Request/Response Next Route Handlers
// (no React/DOM), so they run fine under this same node environment once
// src/lib/supabase/service.ts is mocked at the module boundary (see
// src/testUtils/fakeSupabase.ts + app/api/webhooks/heygen/route.test.ts).
// React components under app/components/** are NOT covered here — they'd
// need jsdom + a component-testing library, neither of which is installed.
//
// middleware.test.ts is listed explicitly (added by the V2 Phase 0 Tester
// pass): middleware.ts lives at the repo root (same level as
// next.config.ts, required by Next's convention), outside src/**, src/lib/jobs/**
// and app/**, so none of the globs above would otherwise pick it up. It's a
// plain (NextRequest) => NextResponse function with @supabase/ssr mocked at
// the module boundary — same node environment, no DOM needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "app/**/*.test.ts", "middleware.test.ts"],
    exclude: ["node_modules", ".next", "dist"],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
