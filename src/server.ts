import { createServer } from "node:http";
import { assertAuthConfigured } from "./http.ts";
import { loadConfig, loadIcp } from "./config.ts";
import { ClaudeClient } from "./claude.ts";
import { ClaudeLeadAI } from "./ai.ts";
import { Enricher, HunterClient } from "./enrich.ts";
import { LeadStore } from "./store.ts";
import { LeadService } from "./service.ts";
import { createRouter } from "./app.ts";

const config = loadConfig();
try {
  assertAuthConfigured(config.HOST, config.API_KEY);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const { icp, source: icpSource } = loadIcp(config.ICP_FILE);
const log = (msg: string, extra?: unknown) =>
  console.log(`[${new Date().toISOString()}] ${msg}`, extra instanceof Error ? extra.stack : (extra ?? ""));

const store = new LeadStore(config.DATABASE_PATH);
const claudeOn = Boolean(config.ANTHROPIC_API_KEY);
const ai = claudeOn
  ? new ClaudeLeadAI(new ClaudeClient({ apiKey: config.ANTHROPIC_API_KEY, model: config.CLAUDE_MODEL, fallbacks: config.CLAUDE_FALLBACKS }))
  : null;
const enricher = new Enricher({
  hunter: config.HUNTER_API_KEY ? new HunterClient(config.HUNTER_API_KEY, { minGapMs: config.HUNTER_MIN_GAP_MS }) : null,
});

const service = new LeadService({
  store,
  enricher,
  ai,
  icp,
  sender: { name: config.SENDER_NAME, company: config.SENDER_COMPANY, offer: config.SENDER_OFFER },
  outreachMinScore: config.OUTREACH_MIN_SCORE,
  concurrency: config.AI_CONCURRENCY,
});

const router = createRouter({
  service,
  store,
  apiKey: config.API_KEY,
  rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
  maxBodyBytes: config.MAX_BODY_BYTES,
  trustProxy: config.TRUST_PROXY,
  status: { claude: claudeOn, providers: enricher.providers, model: config.CLAUDE_MODEL, icpSource },
  log,
});

const server = createServer(router.handle);
server.listen(config.PORT, config.HOST, () => {
  log(`AI Lead Generation Agent listening on http://${config.HOST}:${config.PORT} (ICP: ${icpSource})`);
  if (!config.API_KEY) log("WARNING: API_KEY is not set — the API is unauthenticated (loopback only).");
  if (!claudeOn) log("Claude is NOT configured: scoring/outreach return 503; validation and enrichment still work.");
  if (!config.HUNTER_API_KEY) log("Hunter.io is NOT configured: enrichment is limited to DNS MX checks.");
});

const shutdown = () => server.close(() => (store.close(), process.exit(0)));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
