// Test doubles for Claude and DNS. Used only by the automated tests.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { LeadAI, LeadContext } from "../src/ai.ts";
import { Enricher, type HunterClient } from "../src/enrich.ts";
import { LeadStore } from "../src/store.ts";
import { LeadService } from "../src/service.ts";
import { createRouter } from "../src/app.ts";
import { IcpSchema, type Icp, type Outreach, type Score } from "../src/schemas.ts";

export const fixtureLeads = (JSON.parse(readFileSync(new URL("./fixtures/leads.json", import.meta.url), "utf8")) as { leads: Record<string, unknown>[] }).leads;
export const lead = (i: number) => structuredClone(fixtureLeads[i]);
export const icp: Icp = IcpSchema.parse(JSON.parse(readFileSync(new URL("../config/icp.example.json", import.meta.url), "utf8")));

/** Deterministic scorer driven by the rule-based signals. */
export class StubLeadAI implements LeadAI {
  scored: string[] = [];
  outreached: string[] = [];
  fail?: Error;
  async score(ctx: LeadContext): Promise<Score> {
    if (this.fail) throw this.fail;
    this.scored.push(ctx.lead.company);
    const hits = Object.values(ctx.signals).filter((v) => v === true).length;
    const score = 30 + hits * 15;
    return { score, tier: score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D", reasons: [`${hits} ICP signals matched`], risks: [], missing_data: [] };
  }
  async outreach(ctx: LeadContext): Promise<Outreach> {
    this.outreached.push(ctx.lead.company);
    return { subject: `Idea for ${ctx.lead.company}`, body: "Hi — short note.", personalization: [{ point: ctx.lead.company, source_field: "company" }] };
  }
}

export const fakeMx = (domains: Record<string, boolean>) => async (domain: string) => {
  if (domain in domains) return domains[domain] ? [{ exchange: `mx.${domain}` }] : [];
  throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
};

export function makeService(opts: { ai?: StubLeadAI | null; hunter?: HunterClient | null; outreachMinScore?: number } = {}) {
  const store = new LeadStore(":memory:");
  const ai = opts.ai === undefined ? new StubLeadAI() : opts.ai;
  const enricher = new Enricher({ resolver: fakeMx({ "northfield-logistics.example": true, "brightcart.example": true, "gmail.com": true }), hunter: opts.hunter ?? null });
  const service = new LeadService({
    store,
    enricher,
    ai,
    icp,
    sender: { name: "Mawra", company: "Test Co", offer: "AI workflow automation" },
    outreachMinScore: opts.outreachMinScore ?? 60,
    concurrency: 2,
  });
  return { store, ai, service, enricher };
}

export async function startApp(opts: { apiKey?: string; ai?: StubLeadAI | null; rateLimitPerMinute?: number } = {}) {
  const { store, ai, service, enricher } = makeService({ ai: opts.ai });
  const router = createRouter({
    service,
    store,
    apiKey: opts.apiKey,
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 1000,
    maxBodyBytes: 512 * 1024,
    status: { claude: ai !== null, providers: enricher.providers, model: "test", icpSource: "test" },
  });
  const server = createServer(router.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, ai, close: () => closeServer(server) };
}

export function closeServer(server: Server) {
  return new Promise<void>((r) => server.close(() => r()));
}
