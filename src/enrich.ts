// Enrichment from permitted sources only:
//  - DNS MX lookup (public DNS; checks the email domain can receive mail)
//  - Hunter.io Company Enrichment + Email Verifier (official API, your API key)
// No scraping. Enriched values are stored separately with their source and are
// never merged into the lead as if the lead had supplied them.
import { resolveMx } from "node:dns/promises";
import type { NormalizedLead } from "./normalize.ts";

export type Enrichment = {
  emailDomainAcceptsMail: boolean | null;
  emailVerification: { status: string; score: number | null } | null;
  company: {
    name: string | null;
    industry: string | null;
    employees: number | null;
    country: string | null;
    description: string | null;
    foundedYear: number | null;
  } | null;
  sources: string[];
  errors: string[];
};

export type MxResolver = (domain: string) => Promise<{ exchange: string }[]>;

/** Serialises calls and spaces them out to respect provider rate limits. */
export class Throttle {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private gapMs: number;
  constructor(gapMs: number) {
    this.gapMs = gapMs;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export class HunterClient {
  private apiKey: string;
  private fetchImpl: typeof fetch;
  private throttle: Throttle;
  private maxRetries: number;
  private timeoutMs: number;
  private retryBaseMs: number;

  constructor(
    apiKey: string,
    opts: { fetchImpl?: typeof fetch; minGapMs?: number; maxRetries?: number; timeoutMs?: number; retryBaseMs?: number } = {},
  ) {
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.throttle = new Throttle(opts.minGapMs ?? 250);
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
  }

  /**
   * GET with a per-attempt timeout. Retries 429, 5xx and network/timeout
   * errors up to maxRetries times with exponential backoff; other 4xx fail
   * immediately (retrying a bad request or key only burns quota).
   */
  private async get(path: string, params: Record<string, string>): Promise<any | null> {
    const url = `https://api.hunter.io/v2${path}?${new URLSearchParams({ ...params, api_key: this.apiKey })}`;
    const backoff = (attempt: number) => new Promise((r) => setTimeout(r, 2 ** attempt * this.retryBaseMs));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.throttle.run(() =>
          this.fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) }),
        );
      } catch (err) {
        const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
        if (attempt < this.maxRetries) {
          await backoff(attempt);
          continue;
        }
        throw new Error(timedOut ? `Hunter ${path} timed out after ${this.timeoutMs}ms` : `Hunter ${path} request failed: ${(err as Error).message}`);
      }
      if (res.status === 404) return null; // no data for this domain/email
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) await new Promise((r) => setTimeout(r, retryAfter * 1000));
        else await backoff(attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Hunter ${path} returned HTTP ${res.status}`);
      return ((await res.json()) as { data?: unknown }).data ?? null;
    }
  }

  async company(domain: string): Promise<Enrichment["company"]> {
    const d = await this.get("/companies/find", { domain });
    if (!d) return null;
    const employees = typeof d.metrics?.employees === "number" ? d.metrics.employees : null;
    return {
      name: d.name ?? null,
      industry: d.category?.industry ?? d.category?.sector ?? null,
      employees,
      country: d.geo?.country ?? null,
      description: typeof d.description === "string" ? d.description.slice(0, 500) : null,
      foundedYear: typeof d.foundedYear === "number" ? d.foundedYear : null,
    };
  }

  async verifyEmail(email: string): Promise<Enrichment["emailVerification"]> {
    const d = await this.get("/email-verifier", { email });
    if (!d) return null;
    return { status: String(d.status ?? d.result ?? "unknown"), score: typeof d.score === "number" ? d.score : null };
  }
}

export class Enricher {
  private resolver: MxResolver;
  private hunter: HunterClient | null;
  private mxCache = new Map<string, boolean | null>();

  constructor(opts: { resolver?: MxResolver; hunter?: HunterClient | null } = {}) {
    this.resolver = opts.resolver ?? resolveMx;
    this.hunter = opts.hunter ?? null;
  }

  get providers() {
    return ["dns-mx", ...(this.hunter ? ["hunter"] : [])];
  }

  async enrich(lead: NormalizedLead): Promise<Enrichment> {
    const out: Enrichment = { emailDomainAcceptsMail: null, emailVerification: null, company: null, sources: [], errors: [] };

    if (lead.emailDomain) {
      out.emailDomainAcceptsMail = await this.mx(lead.emailDomain, out);
      out.sources.push("dns-mx");
    }
    if (this.hunter) {
      if (lead.companyDomain) {
        try {
          out.company = await this.hunter.company(lead.companyDomain);
          out.sources.push("hunter:company");
        } catch (err) {
          out.errors.push(`hunter company: ${(err as Error).message}`);
        }
      }
      if (lead.email) {
        try {
          out.emailVerification = await this.hunter.verifyEmail(lead.email);
          out.sources.push("hunter:email-verifier");
        } catch (err) {
          out.errors.push(`hunter email verifier: ${(err as Error).message}`);
        }
      }
    }
    return out;
  }

  private async mx(domain: string, out: Enrichment): Promise<boolean | null> {
    if (this.mxCache.has(domain)) return this.mxCache.get(domain)!;
    let result: boolean | null;
    try {
      const records = await this.resolver(domain);
      result = records.length > 0;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND" || code === "ENODATA") result = false;
      else {
        out.errors.push(`dns-mx: ${code ?? (err as Error).message}`);
        result = null; // transient / unknown — do not claim either way
      }
    }
    this.mxCache.set(domain, result);
    return result;
  }
}
