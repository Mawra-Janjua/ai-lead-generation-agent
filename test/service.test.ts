import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureLeads, makeService } from "./helpers.ts";
import { toCsv, csvField } from "../src/csv.ts";
import { mapLimit } from "../src/service.ts";

const all = { enrich: true, score: true, outreach: true };

test("batch: validates, dedupes (in-batch), enriches, scores and drafts outreach for good fits", async () => {
  const { service, ai } = makeService();
  const { results, summary } = await service.ingestBatch(fixtureLeads, all);
  assert.deepEqual(summary, { total: 8, created: 5, duplicate: 1, invalid: 2, failed: 0 });
  assert.equal(results[4].status, "duplicate");
  assert.equal(results[4].status === "duplicate" && results[4].duplicateOf, "batch:0");
  assert.equal(results[5].status, "invalid");
  assert.equal(results[6].status, "invalid");

  const sarah = results[0].status === "created" ? results[0].lead : null;
  assert.equal(sarah!.score!.tier, "A");
  assert.equal(sarah!.enrichment!.emailDomainAcceptsMail, true);
  assert.ok(sarah!.outreach, "A-tier lead gets an outreach draft");
  const bank = results[3].status === "created" ? results[3].lead : null;
  assert.ok(bank!.score!.score < 60);
  assert.equal(bank!.outreach, null, "below OUTREACH_MIN_SCORE: no draft");
  assert.ok(!ai!.outreached.includes("Quantum Ledger Bank"));
});

test("re-submitting stored leads is detected as duplicates against the database", async () => {
  const { service, store } = makeService();
  await service.ingestBatch(fixtureLeads.slice(0, 2), all);
  const again = await service.ingestBatch(fixtureLeads.slice(0, 2), all);
  assert.deepEqual(again.summary, { total: 2, created: 0, duplicate: 2, invalid: 0, failed: 0 });
  assert.equal(store.list({ limit: 10 }).length, 2);
});

test("AI failures mark individual leads failed without aborting the batch", async () => {
  const { service, ai, store } = makeService();
  ai!.fail = new Error("Claude API rate limit reached");
  const { summary } = await service.ingestBatch(fixtureLeads.slice(0, 2), all);
  assert.equal(summary.failed, 2);
  const failed = store.list({ limit: 5 });
  assert.ok(failed.every((l) => l.status === "failed" && /rate limit/.test(l.error!)));
  ai!.fail = undefined;
  const fixed = await service.rescore(failed[0].id, all);
  assert.equal(fixed.status, "created");
  assert.equal(store.get(failed[0].id)!.status, "scored");
});

test("without Claude, scoring is refused but validation/enrichment-only runs work", async () => {
  const { service } = makeService({ ai: null });
  await assert.rejects(service.ingestBatch(fixtureLeads, all), (e: Error & { code?: string }) => e.code === "ai_not_configured");
  const { summary, results } = await service.ingestBatch(fixtureLeads.slice(0, 1), { enrich: true, score: false, outreach: false });
  assert.equal(summary.created, 1);
  assert.equal(results[0].status === "created" && results[0].lead.score, null);
});

test("analyze is stateless", async () => {
  const { service, store } = makeService();
  const out = await service.analyze(fixtureLeads[1], all);
  assert.equal(out.lead.company, "BrightCart");
  assert.ok(out.score);
  assert.equal(store.list({ limit: 5 }).length, 0);
  await assert.rejects(service.analyze(fixtureLeads[5], all), (e: Error & { status?: number }) => e.status === 400);
});

test("list filters by tier and min score, sorted by score", async () => {
  const { service, store } = makeService();
  await service.ingestBatch(fixtureLeads, all);
  const scores = store.list({ limit: 10 }).map((l) => l.score?.score ?? -1);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(store.list({ tier: "A", limit: 10 }).every((l) => l.score!.tier === "A"));
  assert.ok(store.list({ minScore: 60, limit: 10 }).every((l) => l.score!.score >= 60));
});

test("CSV export quotes fields and neutralises spreadsheet formulas", async () => {
  const { service, store } = makeService();
  await service.ingestBatch(fixtureLeads, all);
  const csv = toCsv(store.list({ limit: 10 }));
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 6, "header + 5 leads");
  assert.ok(lines[0].startsWith("id,full_name,email"));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"")"`), "formula escaped and quoted");
  assert.ok(csv.includes("'+Formula Ltd"));
  assert.equal(csvField('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvField(null), "");
});

test("mapLimit preserves order and respects concurrency", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, n * 5));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20]);
  assert.equal(peak, 2);
});
