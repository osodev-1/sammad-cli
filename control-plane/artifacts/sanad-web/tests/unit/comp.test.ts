import { describe, it, expect, afterEach } from "vitest";
import { compEmails, isOrgComped, COMP_QUOTA } from "@/lib/billing/comp";

describe("comp allowlist", () => {
  const original = process.env.SANAD_COMP_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.SANAD_COMP_EMAILS;
    else process.env.SANAD_COMP_EMAILS = original;
  });

  it("parses, trims, lowercases and drops empty entries", () => {
    process.env.SANAD_COMP_EMAILS = " Foo@Example.com , bar@x.io ,,";
    expect(compEmails()).toEqual(["foo@example.com", "bar@x.io"]);
  });

  it("is empty when the env var is unset", () => {
    delete process.env.SANAD_COMP_EMAILS;
    expect(compEmails()).toEqual([]);
  });

  it("short-circuits to false with no DB access when the allowlist is empty", async () => {
    delete process.env.SANAD_COMP_EMAILS;
    // No db mock is provided; this must not reach the database.
    await expect(isOrgComped("personal_anything")).resolves.toBe(false);
  });

  it("grants an effectively-unlimited monthly allowance", () => {
    expect(COMP_QUOTA.requestsPerMonth).toBeGreaterThan(1_000_000);
    expect(COMP_QUOTA.tokensPerMonth).toBeGreaterThan(1_000_000_000);
  });
});
