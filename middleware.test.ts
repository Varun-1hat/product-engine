/**
 * middleware.ts (BLOCK-1, session-auth gate — .pipeline/spec.md item 1) is
 * new this phase and had zero test coverage. It lives at the repo root
 * (alongside next.config.ts), so it's listed explicitly in vitest.config.ts's
 * `include` rather than falling under src/**, src/lib/jobs/**, or app/**.
 *
 * Mocks ONLY @supabase/ssr's createServerClient — the one SDK boundary
 * middleware.ts talks to — with a controllable fake whose auth.getUser() we
 * flip between "signed in" / "signed out" per test. Everything else (the
 * real routing logic: webhook/auth-route exemptions, 401-vs-redirect
 * branching, the `next` query param) runs unmocked, exercising the actual
 * middleware() function directly (no full Next.js request pipeline needed —
 * middleware() is a plain async (NextRequest) => NextResponse function).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

let mockUser: { id: string } | null = null;

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
    },
  })),
}));

const { middleware } = await import("./middleware");
const { NextRequest } = await import("next/server");

function reqFor(path: string): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost:3000${path}`);
}

describe("middleware — signed out (no user)", () => {
  afterEach(() => {
    mockUser = null;
  });

  it("401s an unauthenticated /api/** request with a JSON error body, without redirecting", async () => {
    mockUser = null;
    const res = await middleware(reqFor("/api/reels"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("401s an unauthenticated nested /api/** route (not just the top-level segment)", async () => {
    mockUser = null;
    const res = await middleware(reqFor("/api/reels/reel-1/clip/estimate"));
    expect(res.status).toBe(401);
  });

  it("redirects an unauthenticated page load to /login?next=<original path>", async () => {
    mockUser = null;
    const res = await middleware(reqFor("/reels/some-reel-id"));
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const loc = new URL(location!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/reels/some-reel-id");
  });

  it("preserves query params of the original page path inside the `next` redirect param", async () => {
    mockUser = null;
    const res = await middleware(reqFor("/clients/client-1"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("next")).toBe("/clients/client-1");
  });

  it("lets an unauthenticated /api/webhooks/** request through untouched (provider callbacks authenticate via their own callback_token, not a session)", async () => {
    mockUser = null;
    const res = await middleware(reqFor("/api/webhooks/heygen?token=abc"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets /login itself through while signed out (otherwise no one could ever reach the sign-in page)", async () => {
    mockUser = null;
    const res = await middleware(reqFor("/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("lets /auth/** (the magic-link callback/signout routes) through while signed out", async () => {
    mockUser = null;
    const res = await middleware(reqFor("/auth/callback?code=abc123&next=/clients"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("middleware — signed in (session user present)", () => {
  afterEach(() => {
    mockUser = null;
  });

  it("passes an authenticated /api/** request through with no 401", async () => {
    mockUser = { id: "user-1" };
    const res = await middleware(reqFor("/api/reels"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("passes an authenticated page load through with no redirect", async () => {
    mockUser = { id: "user-1" };
    const res = await middleware(reqFor("/reels/some-reel-id"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still passes /api/webhooks/** through when a session happens to be present too", async () => {
    mockUser = { id: "user-1" };
    const res = await middleware(reqFor("/api/webhooks/heygen"));
    expect(res.status).toBe(200);
  });
});
