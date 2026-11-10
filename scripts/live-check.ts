// Real-execution check: qualifies ONE fictional fixture lead with the real
// Claude API (and Hunter.io only if HUNTER_API_KEY is set). Nothing is stored.
// Usage: npm run live-check [-- <fixture index, default 1>]
// Costs a small amount of Anthropic credit (one scoring call + at most one outreach call).
import { readFileSync } from "node:fs";
import { loadConfig, loadIcp } from "../src/config.ts";
import { ClaudeClient } from "../src/claude.ts";
import { ClaudeLeadAI } from "../src/ai.ts";
import { Enricher, HunterClient } from "../src/enrich.ts";
import { LeadStore } from "../src/store.ts";
import { LeadService } from "../src/service.ts";

const config = loadConfig();
if (!config.ANTHROPIC_API_KEY) {
  console.error("live-check needs ANTHROPIC_API_KEY (set it in .env or the environment). No request was made and no result is reported.");
  process.exit(2);
}

const { leads } = JSON.parse(readFileSync(new URL("../test/fixtures/leads.json", import.meta.url), "utf8")) as { leads: unknown[] };
const index = Number(process.argv[2] ?? 1);
if (!Number.isInteger(index) || index < 0 || index >= leads.length) {
  console.error(`Fixture index must be 0-${leads.length - 1}.`);
  process.exit(2);
}

const { icp, source } = loadIcp(config.ICP_FILE);
const hunter = config.HUNTER_API_KEY ? new HunterClient(config.HUNTER_API_KEY, { minGapMs: config.HUNTER_MIN_GAP_MS }) : null;
const enricher = new Enricher({ hunter });
const store = new LeadStore(":memory:");
const service = new LeadService({
  store,
  enricher,
  ai: new ClaudeLeadAI(new ClaudeClient({ apiKey: config.ANTHROPIC_API_KEY, model: config.CLAUDE_MODEL, fallbacks: config.CLAUDE_FALLBACKS })),
  icp,
  sender: { name: config.SENDER_NAME, company: config.SENDER_COMPANY, offer: config.SENDER_OFFER },
  outreachMinScore: config.OUTREACH_MIN_SCORE,
  concurrency: 1,
});

console.log(`Model: ${config.CLAUDE_MODEL} · ICP: ${source} · enrichment: ${enricher.providers.join(", ")} · fixture #${index}`);
const started = Date.now();
try {
  const out = await service.analyze(leads[index], { enrich: true, score: true, outreach: true });
  console.log(JSON.stringify({ lead: out.lead, enrichment: out.enrichment, signals: out.signals, score: out.score, outreach: out.outreach, outreachSkipped: out.outreachSkipped }, null, 2));
  console.log(`OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (err) {
  const e = err as Error & { code?: string; status?: number };
  console.error(`FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.code ? `[${e.status} ${e.code}] ` : ""}${e.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
