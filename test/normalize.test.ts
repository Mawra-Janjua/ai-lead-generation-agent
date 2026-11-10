import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeKeys, domainFromUrl, icpSignals, normalizeCountry, normalizeLead, normalizeName } from "../src/normalize.ts";
import { RawLeadSchema } from "../src/schemas.ts";
import { icp, lead } from "./helpers.ts";

const norm = (raw: Record<string, unknown>) => normalizeLead(RawLeadSchema.parse(raw));

test("normalizes casing, email, domain, country and employee count", () => {
  const { lead: l, errors } = norm(lead(0));
  assert.deepEqual(errors, []);
  assert.equal(l!.fullName, "Sarah Khan");
  assert.equal(l!.email, "sarah.khan@northfield-logistics.example");
  assert.equal(l!.companyDomain, "northfield-logistics.example");
  assert.equal(l!.website, "https://northfield-logistics.example");
  assert.equal(l!.country, "United Kingdom");
  assert.equal(l!.employeeCount, 240);
});

test("splits full names and keeps apostrophes", () => {
  const { lead: l } = norm(lead(1));
  assert.equal(l!.firstName, "Daniel");
  assert.equal(l!.lastName, "O'Brien");
  assert.equal(l!.country, "United States");
});

test("mixed-case names are preserved", () => assert.equal(normalizeName("Ronan McDonald"), "Ronan McDonald"));

test("free email domains are not used as the company domain", () => {
  const { lead: l } = norm(lead(2));
  assert.equal(l!.isFreeEmail, true);
  assert.equal(l!.companyDomain, null);
  assert.ok(l!.warnings.some((w) => w.includes("personal email")));
});

test("schema requires company and an email or website", () => {
  assert.equal(RawLeadSchema.safeParse(lead(5)).success, false);
  assert.equal(RawLeadSchema.safeParse({ email: "a@b.example" }).success, false);
  assert.equal(RawLeadSchema.safeParse({ company: "X", employeeCount: "12.5" }).success, false);
});

test("invalid emails and websites are rejected with clear messages", () => {
  const { lead: l, errors } = norm(lead(6));
  assert.equal(l, undefined);
  assert.match(errors[0], /not a valid address/);
  assert.match(norm({ company: "X", website: "not a url!" }).errors[0], /not a valid URL/);
});

test("non-LinkedIn URLs are ignored with a warning", () => {
  const { lead: l } = norm({ company: "X", website: "x.example", linkedinUrl: "https://evil.example/in/x" });
  assert.equal(l!.linkedinUrl, null);
  assert.ok(l!.warnings[0].includes("linkedin"));
});

test("domainFromUrl and normalizeCountry edge cases", () => {
  assert.equal(domainFromUrl("HTTP://WWW.Example.COM/path?q=1"), "example.com");
  assert.equal(domainFromUrl("localhost"), null);
  assert.equal(normalizeCountry("u.s.a."), "United States");
  assert.equal(normalizeCountry("new zealand"), "New Zealand");
});

test("dedupe keys cover email and company+person", () => {
  const a = norm(lead(0)).lead!;
  const b = norm(lead(4)).lead!;
  assert.ok(dedupeKeys(a).some((k) => dedupeKeys(b).includes(k)));
});

test("ICP signals use supplied data and return null when unknown", () => {
  const s = icpSignals(norm(lead(0)).lead!, icp);
  assert.deepEqual(s, { industryMatch: true, sizeMatch: true, countryMatch: true, titleMatch: true });
  const bank = icpSignals(norm(lead(3)).lead!, icp);
  assert.equal(bank.industryMatch, false);
  assert.equal(bank.sizeMatch, false);
  const unknown = icpSignals(norm({ company: "X", website: "x.example" }).lead!, icp);
  assert.deepEqual(unknown, { industryMatch: null, sizeMatch: null, countryMatch: null, titleMatch: null });
});
