import { test } from "node:test";
import assert from "node:assert/strict";
import { Enricher, HunterClient, Throttle } from "../src/enrich.ts";
import { normalizeLead } from "../src/normalize.ts";
import { RawLeadSchema } from "../src/schemas.ts";
import { fakeMx, lead } from "./helpers.ts";

const norm = (raw: Record<string, unknown>) => normalizeLead(RawLeadSchema.parse(raw)).lead!;

test("MX lookup reports true/false and never guesses on transient DNS errors", async () => {
  const e = new Enricher({ resolver: fakeMx({ "northfield-logistics.example": true }) });
  assert.equal((await e.enrich(norm(lead(0)))).emailDomainAcceptsMail, true);
  assert.equal((await e.enrich(norm({ company: "X", email: "a@nomx.example" }))).emailDomainAcceptsMail, false);
  const flaky = new Enricher({ resolver: async () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })) });
  const out = await flaky.enrich(norm(lead(0)));
  assert.equal(out.emailDomainAcceptsMail, null);
  assert.match(out.errors[0], /ETIMEOUT/);
});

test("without Hunter, no company data is invented", async () => {
  const out = await new Enricher({ resolver: fakeMx({}) }).enrich(norm(lead(1)));
  assert.equal(out.company, null);
  assert.equal(out.emailVerification, null);
  assert.deepEqual(out.sources, ["dns-mx"]);
});

test("Hunter client maps company + verifier responses and retries on 429", async () => {
  const calls: string[] = [];
  let companyCalls = 0;
  const fakeFetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    assert.equal(u.searchParams.get("api_key"), "hk");
    if (u.pathname.endsWith("/companies/find")) {
      if (companyCalls++ === 0) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ data: { name: "BrightCart", category: { industry: "Internet Software & Services" }, metrics: { employees: 70 }, geo: { country: "United States" }, description: "x".repeat(900), foundedYear: 2019 } });
    }
    return Response.json({ data: { status: "valid", score: 94 } });
  }) as typeof fetch;
  const hunter = new HunterClient("hk", { fetchImpl: fakeFetch, minGapMs: 0 });
  const out = await new Enricher({ resolver: fakeMx({ "brightcart.example": true }), hunter }).enrich(norm(lead(1)));
  assert.deepEqual(out.company, { name: "BrightCart", industry: "Internet Software & Services", employees: 70, country: "United States", description: "x".repeat(500), foundedYear: 2019 });
  assert.deepEqual(out.emailVerification, { status: "valid", score: 94 });
  assert.deepEqual(out.sources, ["dns-mx", "hunter:company", "hunter:email-verifier"]);
  assert.equal(calls.filter((c) => c.endsWith("/companies/find")).length, 2, "retried once after 429");
});

test("Hunter 404 means 'no data', other failures are recorded not thrown", async () => {
  const fakeFetch = (async (url: string | URL) =>
    String(url).includes("companies") ? new Response("{}", { status: 404 }) : new Response("{}", { status: 500 })) as typeof fetch;
  const out = await new Enricher({ resolver: fakeMx({}), hunter: new HunterClient("hk", { fetchImpl: fakeFetch, minGapMs: 0 }) }).enrich(norm(lead(1)));
  assert.equal(out.company, null);
  assert.equal(out.emailVerification, null);
  assert.match(out.errors.join(), /HTTP 500/);
});

test("Throttle spaces calls apart", async () => {
  const t = new Throttle(40);
  const times: number[] = [];
  await Promise.all([1, 2, 3].map(() => t.run(async () => times.push(Date.now()))));
  assert.ok(times[2] - times[0] >= 75, `calls spaced (${times[2] - times[0]}ms)`);
});
