import { defineConfig } from "vitest/config";
import path from "node:path";

// Pure-logic test config. The pipeline's testable surface (cost engine,
// effective-model routing, continuity/shared-frame lineage, adapter
// validate()/estimate(), assembly-plan construction, job-queue helpers)
// lives in framework-free src/** and worker/** modules, so no DOM/React
// test environment is needed here.
//
// app/**/*.test.ts is included too (added by the Tester pass): the
// app/api/** route handlers are plain Request/Response Next Route Handlers
// (no React/DOM), so they run fine under this same node environment once
// src/lib/supabase/service.ts is mocked at the module boundary (see
// src/testUtils/fakeSupabase.ts + app/api/webhooks/heygen/route.test.ts).
// React components under app/components/** are NOT covered here — they'd
// need jsdom + a component-testing library, neither of which is installed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "worker/**/*.test.ts", "app/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist"],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
