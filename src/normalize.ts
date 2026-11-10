// Deterministic validation + normalization. No network, no AI.
import type { Icp, ParsedLead } from "./schemas.ts";

export type NormalizedLead = {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  emailDomain: string | null;
  isFreeEmail: boolean;
  title: string | null;
  company: string;
  companyDomain: string | null;
  website: string | null;
  linkedinUrl: string | null;
  country: string | null;
  industry: string | null;
  employeeCount: number | null;
  notes: string | null;
  source: string | null;
  warnings: string[];
};

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "yandex.com", "mail.com", "zoho.com",
]);

const COUNTRY_ALIASES: Record<string, string> = {
  us: "United States", usa: "United States", "u.s.": "United States", "u.s.a.": "United States", "united states of america": "United States", america: "United States",
  uk: "United Kingdom", "u.k.": "United Kingdom", gb: "United Kingdom", "great britain": "United Kingdom", england: "United Kingdom",
  uae: "United Arab Emirates", ksa: "Saudi Arabia", de: "Germany", deutschland: "Germany", pk: "Pakistan", in: "India",
  ca: "Canada", au: "Australia", nl: "Netherlands", holland: "Netherlands", fr: "France", es: "Spain",
};

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Title-cases names only when they arrive in a single case ("JANE DOE", "jane doe"). */
export function normalizeName(s: string | undefined): string | null {
  if (!s) return null;
  const v = collapse(s);
  if (!v) return null;
  if (v !== v.toLowerCase() && v !== v.toUpperCase()) return v;
  return v.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function domainFromUrl(input: string | undefined): string | null {
  if (!input) return null;
  let v = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v)) v = `https://${v}`;
  try {
    const host = new URL(v).hostname.replace(/^www\./, "");
    return HOST_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function normalizeCountry(s: string | undefined): string | null {
  if (!s) return null;
  const v = collapse(s);
  const alias = COUNTRY_ALIASES[v.toLowerCase()];
  if (alias) return alias;
  return v.length <= 3 ? v.toUpperCase() : v.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export function normalizeLead(raw: ParsedLead): { lead?: NormalizedLead; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  let email: string | null = null;
  let emailDomain: string | null = null;
  if (raw.email) {
    const e = raw.email.trim().toLowerCase();
    const m = EMAIL_RE.exec(e);
    if (!m) errors.push(`email "${raw.email}" is not a valid address`);
    else {
      email = e;
      emailDomain = m[1];
    }
  }

  let website: string | null = null;
  let siteDomain: string | null = null;
  if (raw.website) {
    siteDomain = domainFromUrl(raw.website);
    if (!siteDomain) errors.push(`website "${raw.website}" is not a valid URL or domain`);
    else website = `https://${siteDomain}`;
  }

  let linkedinUrl: string | null = null;
  if (raw.linkedinUrl) {
    const d = domainFromUrl(raw.linkedinUrl);
    if (!d || !(d === "linkedin.com" || d.endsWith(".linkedin.com"))) warnings.push("linkedinUrl ignored: not a linkedin.com URL");
    else linkedinUrl = raw.linkedinUrl.trim().replace(/^http:/, "https:").replace(/\/+$/, "");
  }

  const isFreeEmail = emailDomain ? FREE_EMAIL_DOMAINS.has(emailDomain) : false;
  if (isFreeEmail) warnings.push("personal email domain; company domain taken from website only");
  const companyDomain = siteDomain ?? (emailDomain && !isFreeEmail ? emailDomain : null);
  if (siteDomain && emailDomain && !isFreeEmail && siteDomain !== emailDomain && !emailDomain.endsWith(`.${siteDomain}`)) {
    warnings.push(`email domain (${emailDomain}) differs from website domain (${siteDomain})`);
  }

  let firstName = normalizeName(raw.firstName);
  let lastName = normalizeName(raw.lastName);
  let fullName = normalizeName(raw.fullName);
  if (!fullName && (firstName || lastName)) fullName = [firstName, lastName].filter(Boolean).join(" ");
  if (fullName && !firstName && !lastName) {
    const parts = fullName.split(" ");
    firstName = parts[0];
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
  }

  if (errors.length) return { errors };
  return {
    errors,
    lead: {
      firstName,
      lastName,
      fullName,
      email,
      emailDomain,
      isFreeEmail,
      title: raw.title ? collapse(raw.title) : null,
      company: collapse(raw.company),
      companyDomain,
      website,
      linkedinUrl,
      country: normalizeCountry(raw.country),
      industry: raw.industry ? collapse(raw.industry) : null,
      employeeCount: raw.employeeCount ?? null,
      notes: raw.notes ? raw.notes.trim() : null,
      source: raw.source ?? null,
      warnings,
    },
  };
}

/**
 * Keys used to detect duplicates: exact email, and company domain + person name.
 * A company-only lead (no name, no email) is keyed by its domain, so the same
 * company is not stored twice; leads that name a person never get this key,
 * so two people at one company stay distinct.
 */
export function dedupeKeys(l: NormalizedLead): string[] {
  const keys: string[] = [];
  if (l.email) keys.push(`email:${l.email}`);
  const org = l.companyDomain ?? `name:${l.company.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  if (l.fullName) keys.push(`person:${org}|${l.fullName.toLowerCase()}`);
  if (!l.email && !l.fullName && l.companyDomain) keys.push(`domain:${l.companyDomain}`);
  return keys;
}

export type IcpSignals = {
  industryMatch: boolean | null;
  sizeMatch: boolean | null;
  countryMatch: boolean | null;
  titleMatch: boolean | null;
};

/** Transparent rule-based signals, shown alongside Claude's score. null = unknown. */
export function icpSignals(l: NormalizedLead, icp: Icp, enrichment?: { industry?: string | null; employees?: number | null; country?: string | null }): IcpSignals {
  const lc = (s: string) => s.toLowerCase();
  const industry = l.industry ?? enrichment?.industry ?? null;
  const employees = l.employeeCount ?? enrichment?.employees ?? null;
  const country = l.country ?? enrichment?.country ?? null;
  const match = (value: string | null, targets: string[]) =>
    targets.length === 0 || value === null ? null : targets.some((t) => lc(value).includes(lc(t)) || lc(t).includes(lc(value)));
  const { min, max } = icp.employeeRange;
  return {
    industryMatch: match(industry, icp.targetIndustries),
    sizeMatch: employees === null || (min === undefined && max === undefined) ? null : (min === undefined || employees >= min) && (max === undefined || employees <= max),
    countryMatch: match(country, icp.targetCountries),
    titleMatch: match(l.title, icp.targetTitles),
  };
}
