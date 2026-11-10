// Shared HTTP-layer behaviour: auth, rate limiting, proxy trust, path decoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Router, assertAuthConfigured } from "../src/http.ts";

const KEY = "test-key-0123456789abcdef";

async function start(opts: { trustProxy?: boolean; limit?: number } = {}) {
  const router = new Router({ apiKey: KEY, rateLimitPerMinute: opts.limit ?? 2, maxBodyBytes: 1024, trustProxy: opts.trustProxy });
  router.on("GET", "/health", () => ({ json: { ok: true } }), { public: true });
  router.on("GET", "/api/items/:id", (ctx) => ({ json: { id: ctx.params.id } }));
  const server: Server = createServer(router.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("failed API-key attempts are rate limited", async () => {
  const s = await start({ limit: 2 });
  try {
    const bad = { headers: { "x-api-key": "wrong" } };
    assert.equal((await fetch(`${s.url}/api/items/1`, bad)).status, 401);
    assert.equal((await fetch(`${s.url}/api/items/1`, bad)).status, 401);
    assert.equal((await fetch(`${s.url}/api/items/1`, bad)).status, 429);
  } finally {
    await s.close();
  }
});

test("X-Forwarded-For is ignored unless TRUST_PROXY is enabled", async () => {
  const s = await start({ limit: 1 });
  try {
    const h = (ip: string) => ({ headers: { "x-api-key": KEY, "x-forwarded-for": ip } });
    assert.equal((await fetch(`${s.url}/api/items/1`, h("1.1.1.1"))).status, 200);
    assert.equal((await fetch(`${s.url}/api/items/1`, h("2.2.2.2"))).status, 429, "spoofed header must not reset the limit");
  } finally {
    await s.close();
  }
});

test("X-Forwarded-For identifies clients behind a trusted proxy", async () => {
  const s = await start({ limit: 1, trustProxy: true });
  try {
    const h = (ip: string) => ({ headers: { "x-api-key": KEY, "x-forwarded-for": ip } });
    assert.equal((await fetch(`${s.url}/api/items/1`, h("1.1.1.1"))).status, 200);
    assert.equal((await fetch(`${s.url}/api/items/1`, h("2.2.2.2"))).status, 200);
    assert.equal((await fetch(`${s.url}/api/items/1`, h("1.1.1.1"))).status, 429);
  } finally {
    await s.close();
  }
});

test("malformed percent-encoding returns 400, not 500", async () => {
  const s = await start({ limit: 10 });
  try {
    const res = await fetch(`${s.url}/api/items/%E0%A4%A`, { headers: { "x-api-key": KEY } });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "invalid_path");
  } finally {
    await s.close();
  }
});

test("JSON responses carry security and no-store headers", async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.url}/health`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    await s.close();
  }
});

test("an unauthenticated API may only listen on loopback", () => {
  assert.doesNotThrow(() => assertAuthConfigured("127.0.0.1", undefined));
  assert.doesNotThrow(() => assertAuthConfigured("0.0.0.0", "a-long-enough-api-key"));
  assert.throws(() => assertAuthConfigured("0.0.0.0", undefined), /API_KEY is not set/);
  assert.throws(() => assertAuthConfigured("0.0.0.0", "short"), /at least 16/);
});
