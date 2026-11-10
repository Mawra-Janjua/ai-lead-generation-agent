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
  | { index: number; status: "created" | "failed"; lead: LeadRecord; errors: string[]; replayed?: true };

type Prepared =
  | LeadResult
  | { index: number; rec: LeadRecord; done: (r: LeadResult) => void; fail: (e: unknown) => void }
  | { index: number; replayOf: string };

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
  /** Leads currently being enriched/scored, so an idempotent retry can wait for the original result. */
  private inflight = new Map<string, Promise<LeadResult>>();
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

  /**
   * Validates, dedupes and stores a batch, then enriches/scores the new leads.
   * Dedupe keys are claimed synchronously (one SQLite transaction per lead)
   * before any await, so concurrent requests cannot both create the same lead.
   * With an idempotency key, a re-sent batch (e.g. an n8n retry after a
   * timeout) gets the original results back instead of "duplicate".
   */
  async ingestBatch(raws: unknown[], opts: ProcessOptions, idemKey?: string): Promise<{ results: LeadResult[]; summary: Record<string, number> }> {
    this.needAI(opts);
    const seenInBatch = new Map<string, number>();
    const prepared: Prepared[] = raws.map((raw, index) => {
      const v = this.validate(raw);
      if (!v.valid) return { index, status: "invalid" as const, errors: v.errors };
      const keys = dedupeKeys(v.lead);
      const dupIndex = keys.map((k) => seenInBatch.get(k)).find((x) => x !== undefined);
      if (dupIndex !== undefined) return { index, status: "duplicate" as const, duplicateOf: `batch:${dupIndex}`, errors: [] };
      const claimed = this.d.store.claim(v.lead, keys, idemKey);
      if ("duplicateOf" in claimed) {
        if (!idemKey || !this.d.store.createdWithKey(claimed.duplicateOf, idemKey)) {
          return { index, status: "duplicate" as const, duplicateOf: claimed.duplicateOf, errors: [] };
        }
        keys.forEach((k) => seenInBatch.set(k, index));
        return { index, replayOf: claimed.duplicateOf };
      }
      keys.forEach((k) => seenInBatch.set(k, index));
      let done!: (r: LeadResult) => void;
      let fail!: (e: unknown) => void;
      const promise = new Promise<LeadResult>((res, rej) => ((done = res), (fail = rej)));
      promise.catch(() => undefined);
      this.inflight.set(claimed.rec.id, promise);
      return { index, rec: claimed.rec, done, fail };
    });

    const results = await mapLimit(prepared, this.d.concurrency, async (p): Promise<LeadResult> => {
      if ("status" in p) return p;
      if ("replayOf" in p) return this.replay(p.replayOf, p.index);
      try {
        const r = await this.processRecord(p.rec, opts, p.index);
        p.done(r);
        return r;
      } catch (err) {
        p.fail(err);
        throw err;
      } finally {
        this.inflight.delete(p.rec.id);
      }
    });

    const summary: Record<string, number> = { total: results.length, created: 0, duplicate: 0, invalid: 0, failed: 0 };
    for (const r of results) summary[r.status]++;
    return { results, summary };
  }

  /** Result for a lead this idempotency key already created: wait for it if still processing. */
  private async replay(id: string, index: number): Promise<LeadResult> {
    const pending = this.inflight.get(id);
    if (pending) return { ...(await pending), index, replayed: true } as LeadResult;
    const rec = this.d.store.get(id)!;
    return rec.status === "failed"
      ? { index, status: "failed", lead: rec, errors: [rec.error ?? "failed"], replayed: true }
      : { index, status: "created", lead: rec, errors: [], replayed: true };
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
    return { lead: v.lead, enrichment: ctx.enrichment, signals: ctx.signals, score, outreach, outreachSkipped: opts.outreach && !outreach ? this.outreachSkipReason(opts, score) : null };
  }

  private outreachSkipReason(opts: ProcessOptions, score: { score: number } | null) {
    if (!opts.score) return "outreach requires scoring; call with score=true";
    return `score ${score?.score ?? "unknown"} is below OUTREACH_MIN_SCORE (${this.d.outreachMinScore})`;
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
