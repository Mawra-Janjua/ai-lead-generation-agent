import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureLeads, makeService, StubLeadAI } from "./helpers.ts";
import { HunterClient } from "../src/enrich.ts";
import type { LeadContext } from "../src/ai.ts";
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

/** Stub whose score() waits, so concurrent requests overlap. */
class SlowAI extends StubLeadAI {
  delayMs = 20;
  override async score(ctx: LeadContext) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.score(ctx);
  }
}

test("concurrent requests with the same lead create it exactly once", async () => {
  const { service, store } = makeService({ ai: new SlowAI() });
  const same = { fullName: "Race Condition", email: "race@race.example", company: "Race Co", website: "race.example" };
  // The shared lead sits after the first `concurrency` items, i.e. past an await.
  const batchA = [fixtureLeads[0], fixtureLeads[1], same];
  const batchB = [fixtureLeads[3], fixtureLeads[7], same];
  const [a, b] = await Promise.all([service.ingestBatch(batchA, all), service.ingestBatch(batchB, all)]);
  const outcomes = [a.results[2].status, b.results[2].status].sort();
  assert.deepEqual(outcomes, ["created", "duplicate"]);
  const stored = store.list({ limit: 20 });
  assert.equal(stored.filter((l) => l.lead.email === "race@race.example").length, 1);
  assert.equal(stored.length, 5);
});

test("company-only leads with the same website are deduped; different people are not", async () => {
  const { service } = makeService();
  const first = await service.ingestBatch([{ company: "Acme", website: "acme.example" }, { company: "Acme", fullName: "Jane Roe", website: "acme.example" }], all);
  assert.deepEqual(first.summary, { total: 2, created: 2, duplicate: 0, invalid: 0, failed: 0 });
  const again = await service.ingestBatch([{ company: "ACME", website: "https://www.acme.example" }, { company: "Acme", fullName: "John Poe", website: "acme.example" }], all);
  assert.equal(again.results[0].status, "duplicate");
  assert.equal(again.results[1].status, "created");
});

test("an idempotent retry returns the original results instead of duplicates", async () => {
  const ai = new SlowAI();
  const { service, store } = makeService({ ai });
  const batch = fixtureLeads.slice(0, 5);
  // First attempt still running when the retry arrives (client timed out).
  const firstP = service.ingestBatch(batch, all, "exec-1");
  const retry = await service.ingestBatch(batch, all, "exec-1");
  const first = await firstP;
  assert.deepEqual(retry.summary, first.summary);
  assert.deepEqual(retry.summary, { total: 5, created: 4, duplicate: 1, invalid: 0, failed: 0 });
  for (const [i, r] of retry.results.entries()) {
    assert.equal(r.status, first.results[i].status);
    if (r.status === "created") {
      assert.equal(r.replayed, true);
      assert.ok(r.lead.score, "replay waits for the original scoring");
      assert.equal(r.lead.id, (first.results[i] as typeof r).lead.id);
    }
  }
  assert.equal(retry.results[4].status === "duplicate" && retry.results[4].duplicateOf, "batch:0");
  assert.equal(store.list({ limit: 20 }).length, 4);
  // A later retry (first attempt finished) replays from the database.
  const late = await service.ingestBatch(batch, all, "exec-1");
  assert.equal(late.summary.created, 4);
  // A different key, or no key, still reports duplicates.
  assert.equal((await service.ingestBatch(batch, all, "exec-2")).summary.duplicate, 5);
  assert.equal((await service.ingestBatch(batch, all)).summary.duplicate, 5);
  assert.equal(ai.scored.length, 4, "nothing was scored twice");
});

test("analyze explains why outreach was skipped", async () => {
  const { service } = makeService();
  const noScore = await service.analyze(fixtureLeads[0], { enrich: false, score: false, outreach: true });
  assert.equal(noScore.outreach, null);
  assert.match(noScore.outreachSkipped!, /requires scoring/);
  const low = await service.analyze(fixtureLeads[3], all);
  assert.match(low.outreachSkipped!, /below OUTREACH_MIN_SCORE \(60\)/);
  const good = await service.analyze(fixtureLeads[0], all);
  assert.equal(good.outreachSkipped, null);
});

test("an enrichment provider failure does not fail the lead", async () => {
  const down = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  const { service } = makeService({ hunter: new HunterClient("hk", { fetchImpl: down, minGapMs: 0, retryBaseMs: 0 }) });
  const { results } = await service.ingestBatch([fixtureLeads[0]], all);
  assert.equal(results[0].status, "created");
  const rec = results[0].status === "created" ? results[0].lead : null;
  assert.ok(rec!.score);
  assert.match(rec!.enrichment!.errors.join(), /hunter company: .*HTTP 503/);
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
