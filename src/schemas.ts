import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), text(max).optional());

/** Raw lead as submitted (form, CSV row, n8n, API). Normalized afterwards. */
export const RawLeadSchema = z
  .object({
    firstName: optionalText(100),
    lastName: optionalText(100),
    fullName: optionalText(200),
    email: optionalText(320),
    title: optionalText(200),
    company: text(200).min(1, "company is required"),
    website: optionalText(500),
    linkedinUrl: optionalText(500),
    country: optionalText(100),
    industry: optionalText(150),
    employeeCount: z.preprocess(
      (v) => (v === "" || v === null ? undefined : typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : v),
      z.number().int("employeeCount must be a whole number").min(0).max(10_000_000).optional(),
    ),
    notes: optionalText(2000),
    source: optionalText(100),
  })
  .refine((l) => l.email || l.website, { message: "Provide at least an email or a website", path: ["email"] });
export type RawLead = z.input<typeof RawLeadSchema>;
export type ParsedLead = z.output<typeof RawLeadSchema>;

export const BatchSchema = z.object({
  leads: z.array(z.unknown()).min(1, "leads must contain at least one lead").max(50, "At most 50 leads per request"),
});

export const IcpSchema = z.object({
  name: text(100).default("Default ICP"),
  description: text(2000).min(1),
  targetIndustries: z.array(text(100)).default([]),
  employeeRange: z.object({ min: z.number().int().min(0).optional(), max: z.number().int().positive().optional() }).default({}),
  targetCountries: z.array(text(100)).default([]),
  targetTitles: z.array(text(100)).default([]),
  exclusions: z.array(text(200)).default([]),
});
export type Icp = z.infer<typeof IcpSchema>;

/** Structured output requested from Claude for scoring. */
export const ScoreSchema = z.object({
  score: z.number().describe("0-100 fit against the ICP"),
  tier: z.enum(["A", "B", "C", "D"]).describe("A: strong fit, B: good, C: weak, D: not a fit"),
  reasons: z.array(z.string()).describe("Evidence-based reasons that reference supplied fields"),
  risks: z.array(z.string()),
  missing_data: z.array(z.string()).describe("Fields that would change the score if known"),
});
export type Score = z.infer<typeof ScoreSchema>;

export const LEAD_FIELDS = [
  "fullName",
  "title",
  "company",
  "companyDomain",
  "country",
  "industry",
  "employeeCount",
  "notes",
  "enrichment.industry",
  "enrichment.employees",
  "enrichment.country",
  "enrichment.description",
] as const;

/** Structured output requested from Claude for outreach. */
export const OutreachSchema = z.object({
  subject: z.string(),
  body: z.string(),
  personalization: z
    .array(z.object({ point: z.string(), source_field: z.enum(LEAD_FIELDS) }))
    .describe("Each personalised detail and the supplied field it came from"),
});
export type Outreach = z.infer<typeof OutreachSchema>;
