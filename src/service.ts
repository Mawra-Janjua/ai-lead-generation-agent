import { HttpError } from "./http.ts";
import { dedupeKeys, icpSignals, normalizeLead, type NormalizedLead } from "./normalize.ts";
import { RawLeadSchema, type Icp } from "./schemas.ts";
import type { Enricher } from "./enrich.ts";
import type { LeadAI, LeadContext } from "./ai.ts";
import type { LeadRecord, LeadStore } from "./store.ts";

export type ProcessOptions = { enrich: boolean; score: boolean; outreach: boolean };
export type Sender = { name: string; company: string; offer: string };

export type LeadResult =
  | { index: number; status: "invalid"; errors: string[] }
  | { index: number; status: "duplicate"; duplicateOf: string; errors: string[] }
  | { index: number; status: "created" | "failed"; lead: LeadRecord; errors: string[] };

/** Runs async tasks with a fixed concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export type ServiceDeps = {
  store: LeadStore;
  enricher: Enricher;
  ai: LeadAI | null;
  icp: Icp;
  sender: Sender;
  outreachMinScore: number;
  concurrency: number;
};

export class LeadService {
  private d: ServiceDeps;
  constructor(deps: ServiceDeps) {
    this.d = deps;
  }

  get icp() {
    return this.d.icp;
  }

  /** Pure validation + normalization (no storage, no network). */
  validate(raw: unknown) {
    const parsed = RawLeadSchema.safeParse(raw);
    if (!parsed.success) return { valid: false as const, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "lead"}: ${i.message}`) };
    const { lead, errors } = normalizeLead(parsed.data);
    if (!lead) return { valid: false as const, errors };
    return { valid: true as const, lead, errors: [] as string[] };
  }

  private needAI(opts: ProcessOptions) {
    if ((opts.score || opts.outreach) && !this.d.ai) {
      throw new HttpError(503, "ai_not_configured", "Claude is not configured. Set ANTHROPIC_API_KEY, or call with score=false&outreach=false.");
    }
  }

  async ingestBatch(raws: unknown[], opts: ProcessOptions): Promise<{ results: LeadResult[]; summary: Record<string, number> }> {
    this.needAI(opts);
    const seenInBatch = new Map<string, number>();
    const prepared: (LeadResult | { index: number; lead: NormalizedLead; keys: string[] })[] = raws.map((raw, index) => {
      const v = this.validate(raw);
      if (!v.valid) return { index, status: "invalid" as const, errors: v.errors };
      const keys = dedupeKeys(v.lead);
      const existing = this.d.store.findDuplicate(keys);
      if (existing) return { index, status: "duplicate" as const, duplicateOf: existing, errors: [] };
      const dupIndex = keys.map((k) => seenInBatch.get(k)).find((x) => x !== undefined);
      if (dupIndex !== undefined) return { index, status: "duplicate" as const, duplicateOf: `batch:${dupIndex}`, errors: [] };
      keys.forEach((k) => seenInBatch.set(k, index));
      return { index, lead: v.lead, keys };
    });

    const results = await mapLimit(prepared, this.d.concurrency, async (p): Promise<LeadResult> => {
      if ("status" in p) return p;
      const rec = this.d.store.insert(p.lead, p.keys);
      return this.processRecord(rec, opts, p.index);
    });

    const summary: Record<string, number> = { total: results.length, created: 0, duplicate: 0, invalid: 0, failed: 0 };
    for (const r of results) summary[r.status]++;
    return { results, summary };
  }

  async rescore(id: string, opts: ProcessOptions) {
    this.needAI(opts);
    const rec = this.d.store.get(id);
    if (!rec) throw new HttpError(404, "not_found", `Lead ${id} not found.`);
    return this.processRecord(rec, opts, 0);
  }

  /** Stateless pipeline for the portfolio demo: nothing is stored. */
  async analyze(raw: unknown, opts: ProcessOptions) {
    this.needAI(opts);
    const v = this.validate(raw);
    if (!v.valid) throw new HttpError(400, "validation_failed", "Lead failed validation.", v.errors);
    const ctx = await this.buildContext(v.lead, opts.enrich);
    const score = opts.score ? await this.d.ai!.score(ctx, this.d.icp) : null;
    const outreach = opts.outreach && score && score.score >= this.d.outreachMinScore ? await this.d.ai!.outreach(ctx, this.d.icp, this.d.sender) : null;
    return { lead: v.lead, enrichment: ctx.enrichment, signals: ctx.signals, score, outreach, outreachSkipped: opts.outreach && !outreach ? `score below ${this.d.outreachMinScore}` : null };
  }

  private async buildContext(lead: NormalizedLead, enrich: boolean): Promise<LeadContext> {
    const enrichment = enrich ? await this.d.enricher.enrich(lead) : null;
    return { lead, enrichment, signals: icpSignals(lead, this.d.icp, enrichment?.company ?? undefined) };
  }

  private async processRecord(rec: LeadRecord, opts: ProcessOptions, index: number): Promise<LeadResult> {
    try {
      const ctx = await this.buildContext(rec.lead, opts.enrich);
      rec.enrichment = ctx.enrichment ?? rec.enrichment;
      rec.signals = ctx.signals;
      if (opts.score) {
        rec.score = await this.d.ai!.score(ctx, this.d.icp);
        rec.status = "scored";
      }
      if (opts.outreach && rec.score && rec.score.score >= this.d.outreachMinScore) {
        rec.outreach = await this.d.ai!.outreach(ctx, this.d.icp, this.d.sender);
      }
      rec.error = null;
      this.d.store.save(rec);
      return { index, status: "created", lead: rec, errors: [] };
    } catch (err) {
      rec.status = "failed";
      rec.error = err instanceof Error ? err.message : String(err);
      this.d.store.save(rec);
      return { index, status: "failed", lead: rec, errors: [rec.error] };
    }
  }
}
