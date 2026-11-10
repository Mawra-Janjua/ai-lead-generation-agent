import type { LeadRecord } from "./store.ts";

/** RFC 4180 field quoting + spreadsheet formula-injection protection. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  "id", "full_name", "email", "title", "company", "company_domain", "country", "industry", "employee_count",
  "email_domain_accepts_mail", "email_verification", "enriched_industry", "enriched_employees", "enrichment_sources",
  "score", "tier", "reasons", "risks", "missing_data", "outreach_subject", "outreach_body", "status", "error", "created_at",
] as const;

export function leadToRow(r: LeadRecord): Record<(typeof CSV_COLUMNS)[number], unknown> {
  return {
    id: r.id,
    full_name: r.lead.fullName,
    email: r.lead.email,
    title: r.lead.title,
    company: r.lead.company,
    company_domain: r.lead.companyDomain,
    country: r.lead.country,
    industry: r.lead.industry,
    employee_count: r.lead.employeeCount,
    email_domain_accepts_mail: r.enrichment?.emailDomainAcceptsMail ?? "",
    email_verification: r.enrichment?.emailVerification?.status ?? "",
    enriched_industry: r.enrichment?.company?.industry ?? "",
    enriched_employees: r.enrichment?.company?.employees ?? "",
    enrichment_sources: r.enrichment?.sources.join("; ") ?? "",
    score: r.score?.score ?? "",
    tier: r.score?.tier ?? "",
    reasons: r.score?.reasons.join(" | ") ?? "",
    risks: r.score?.risks.join(" | ") ?? "",
    missing_data: r.score?.missing_data.join(" | ") ?? "",
    outreach_subject: r.outreach?.subject ?? "",
    outreach_body: r.outreach?.body ?? "",
    status: r.status,
    error: r.error ?? "",
    created_at: r.createdAt,
  };
}

export function toCsv(records: LeadRecord[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of records) {
    const row = leadToRow(r);
    lines.push(CSV_COLUMNS.map((c) => csvField(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
