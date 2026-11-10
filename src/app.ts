import { HttpError, Router } from "./http.ts";
import { BatchSchema } from "./schemas.ts";
import { toCsv } from "./csv.ts";
import type { LeadService, ProcessOptions } from "./service.ts";
import type { LeadStore } from "./store.ts";

export type AppOptions = {
  service: LeadService;
  store: LeadStore;
  apiKey?: string;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  status: { claude: boolean; providers: string[]; model: string; icpSource: string };
  log?: (msg: string, extra?: unknown) => void;
};

function options(q: URLSearchParams): ProcessOptions {
  const flag = (name: string) => q.get(name) !== "false";
  return { enrich: flag("enrich"), score: flag("score"), outreach: flag("outreach") };
}

export function createRouter(o: AppOptions) {
  const r = new Router({ apiKey: o.apiKey, rateLimitPerMinute: o.rateLimitPerMinute, maxBodyBytes: o.maxBodyBytes, log: o.log });

  r.on(
    "GET",
    "/health",
    () => ({
      json: {
        ok: true,
        service: "ai-lead-generation-agent",
        integrations: { claude: o.status.claude, enrichment: o.status.providers },
        model: o.status.claude ? o.status.model : null,
      },
    }),
    { public: true },
  );

  r.on("GET", "/api/icp", () => ({ json: { icp: o.service.icp, source: o.status.icpSource } }));

  r.on("POST", "/api/leads/validate", async (ctx) => {
    const { leads } = BatchSchema.parse(await ctx.body());
    return { json: { results: leads.map((l, index) => ({ index, ...o.service.validate(l) })) } };
  });

  r.on("POST", "/api/leads", async (ctx) => {
    const { leads } = BatchSchema.parse(await ctx.body());
    return { json: await o.service.ingestBatch(leads, options(ctx.query)) };
  });

  r.on("POST", "/api/analyze", async (ctx) => ({ json: await o.service.analyze(await ctx.body(), options(ctx.query)) }));

  r.on("GET", "/api/leads", (ctx) => {
    const tier = ctx.query.get("tier") ?? undefined;
    if (tier && !["A", "B", "C", "D"].includes(tier)) throw new HttpError(400, "invalid_tier", "tier must be A, B, C or D");
    const minRaw = ctx.query.get("minScore");
    const minScore = minRaw === null ? undefined : Number(minRaw);
    if (minScore !== undefined && !Number.isFinite(minScore)) throw new HttpError(400, "invalid_min_score", "minScore must be a number");
    const limit = Math.min(1000, Math.max(1, Number(ctx.query.get("limit") ?? 100) || 100));
    return { json: { leads: o.store.list({ tier, minScore, limit }) } };
  });

  r.on("GET", "/api/leads/export.csv", (ctx) => {
    const tier = ctx.query.get("tier") ?? undefined;
    const minScore = ctx.query.get("minScore") ? Number(ctx.query.get("minScore")) : undefined;
    const csv = toCsv(o.store.list({ tier, minScore, limit: 10_000 }));
    return {
      text: csv,
      contentType: "text/csv; charset=utf-8",
      headers: { "content-disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"` },
    };
  });

  r.on("GET", "/api/leads/:id", (ctx) => {
    const lead = o.store.get(ctx.params.id);
    if (!lead) throw new HttpError(404, "not_found", `Lead ${ctx.params.id} not found.`);
    return { json: { lead } };
  });

  r.on("POST", "/api/leads/:id/rescore", async (ctx) => ({ json: await o.service.rescore(ctx.params.id, options(ctx.query)) }));

  return r;
}
