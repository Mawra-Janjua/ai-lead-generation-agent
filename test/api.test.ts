import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureLeads, startApp } from "./helpers.ts";

const KEY = "lead-key";
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify(body) });
const get = { headers: { "x-api-key": KEY } };

test("auth + health", async () => {
  const app = await startApp({ apiKey: KEY });
  try {
    const h = (await (await fetch(`${app.base}/health`)).json()) as any;
    assert.deepEqual(h.integrations, { claude: true, enrichment: ["dns-mx"] });
    assert.equal((await fetch(`${app.base}/api/leads`)).status, 401);
  } finally {
    await app.close();
  }
});

test("batch ingest → list → detail → CSV export over HTTP", async () => {
  const app = await startApp({ apiKey: KEY });
  try {
    const res = await fetch(`${app.base}/api/leads`, post({ leads: fixtureLeads }));
    assert.equal(res.status, 200);
    const out = (await res.json()) as any;
    assert.equal(out.summary.created, 5);

    const list = (await (await fetch(`${app.base}/api/leads?tier=A`, get)).json()) as any;
    assert.ok(list.leads.length >= 1);
    const detail = (await (await fetch(`${app.base}/api/leads/${list.leads[0].id}`, get)).json()) as any;
    assert.equal(detail.lead.id, list.leads[0].id);

    const csv = await fetch(`${app.base}/api/leads/export.csv`, get);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type")!, /text\/csv/);
    assert.match(csv.headers.get("content-disposition")!, /attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.equal((await csv.text()).trim().split("\r\n").length, 6);
  } finally {
    await app.close();
  }
});

test("validate endpoint is stateless and reports per-lead errors", async () => {
  const app = await startApp({ apiKey: KEY });
  try {
    const out = (await (await fetch(`${app.base}/api/leads/validate`, post({ leads: fixtureLeads }))).json()) as any;
    assert.equal(out.results.length, 8);
    assert.equal(out.results[5].valid, false);
    assert.equal(app.store.list({ limit: 5 }).length, 0);
  } finally {
    await app.close();
  }
});

test("request validation: empty batch, oversized batch, bad query params", async () => {
  const app = await startApp({ apiKey: KEY });
  try {
    assert.equal((await fetch(`${app.base}/api/leads`, post({ leads: [] }))).status, 400);
    assert.equal((await fetch(`${app.base}/api/leads`, post({ leads: Array(51).fill(fixtureLeads[0]) }))).status, 400);
    assert.equal((await fetch(`${app.base}/api/leads?tier=Z`, get)).status, 400);
    assert.equal((await fetch(`${app.base}/api/leads?minScore=abc`, get)).status, 400);
    assert.equal((await fetch(`${app.base}/api/leads/export.csv?tier=Z`, get)).status, 400);
    const bad = await fetch(`${app.base}/api/leads/export.csv?minScore=abc`, get);
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /invalid_min_score/);
    assert.equal((await fetch(`${app.base}/api/leads/export.csv?tier=A&minScore=50`, get)).status, 200);
    assert.equal((await fetch(`${app.base}/api/leads/nope`, get)).status, 404);
  } finally {
    await app.close();
  }
});

test("Idempotency-Key header makes a re-sent batch return the original results", async () => {
  const app = await startApp({ apiKey: KEY });
  try {
    const send = (key: string, leads = fixtureLeads.slice(0, 2)) =>
      fetch(`${app.base}/api/leads`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY, "idempotency-key": key }, body: JSON.stringify({ leads }) });
    const first = (await (await send("n8n-42")).json()) as any;
    const retry = (await (await send("n8n-42")).json()) as any;
    assert.deepEqual(retry.summary, first.summary);
    assert.equal(retry.results[0].replayed, true);
    assert.equal(retry.results[0].lead.id, first.results[0].lead.id);
    assert.equal((await send("x".repeat(201), [fixtureLeads[3]])).status, 400);
  } finally {
    await app.close();
  }
});

test("without Claude: 503 for scoring, but ?score=false&outreach=false works", async () => {
  const app = await startApp({ apiKey: KEY, ai: null });
  try {
    const r = await fetch(`${app.base}/api/analyze`, post(fixtureLeads[0]));
    assert.equal(r.status, 503);
    const ok = await fetch(`${app.base}/api/analyze?score=false&outreach=false`, post(fixtureLeads[0]));
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as any;
    assert.equal(body.score, null);
    assert.equal(body.lead.companyDomain, "northfield-logistics.example");
  } finally {
    await app.close();
  }
});
