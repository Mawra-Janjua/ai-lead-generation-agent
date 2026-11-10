import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { startApp } from "./helpers.ts";

test("config: loopback HOST and TRUST_PROXY=false by default; TRUST_PROXY parsed strictly", () => {
  const c = loadConfig({});
  assert.equal(c.HOST, "127.0.0.1");
  assert.equal(c.TRUST_PROXY, false);
  assert.equal(c.MAX_BODY_BYTES, 512 * 1024);
  assert.equal(loadConfig({ TRUST_PROXY: "true" }).TRUST_PROXY, true);
  assert.equal(loadConfig({ TRUST_PROXY: "false" }).TRUST_PROXY, false);
  assert.throws(() => loadConfig({ TRUST_PROXY: "yes" }), /TRUST_PROXY/);
});

test("createRouter passes trustProxy through to the rate limiter", async () => {
  const hit = (base: string, ip: string) => fetch(`${base}/api/icp`, { headers: { "x-forwarded-for": ip } });
  for (const trustProxy of [true, false]) {
    const app = await startApp({ rateLimitPerMinute: 1, trustProxy });
    try {
      assert.equal((await hit(app.base, "203.0.113.1")).status, 200);
      // A different forwarded client gets its own budget only when the proxy is trusted.
      assert.equal((await hit(app.base, "203.0.113.2")).status, trustProxy ? 200 : 429);
    } finally {
      await app.close();
    }
  }
});
