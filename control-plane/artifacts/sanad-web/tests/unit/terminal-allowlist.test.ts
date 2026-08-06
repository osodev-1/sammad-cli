import { describe, it, expect, afterEach } from "vitest";
import { terminalEmails, isTerminalAllowed } from "@/lib/auth/terminal";

describe("terminal allowlist", () => {
  const original = process.env.SANAD_TERMINAL_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.SANAD_TERMINAL_EMAILS;
    else process.env.SANAD_TERMINAL_EMAILS = original;
  });

  it("parses, trims, lowercases and drops empty entries", () => {
    process.env.SANAD_TERMINAL_EMAILS = " Foo@Example.com , bar@x.io ,,";
    expect(terminalEmails()).toEqual(["foo@example.com", "bar@x.io"]);
  });

  it("FAILS CLOSED: empty or unset allowlist denies everyone", () => {
    delete process.env.SANAD_TERMINAL_EMAILS;
    expect(isTerminalAllowed("anyone@example.com")).toBe(false);
    process.env.SANAD_TERMINAL_EMAILS = "";
    expect(isTerminalAllowed("anyone@example.com")).toBe(false);
  });

  it("matches case-insensitively", () => {
    process.env.SANAD_TERMINAL_EMAILS = "omar@example.com";
    expect(isTerminalAllowed("Omar@Example.COM")).toBe(true);
    expect(isTerminalAllowed("other@example.com")).toBe(false);
  });

  it("denies null/undefined/empty email", () => {
    process.env.SANAD_TERMINAL_EMAILS = "omar@example.com";
    expect(isTerminalAllowed(null)).toBe(false);
    expect(isTerminalAllowed(undefined)).toBe(false);
    expect(isTerminalAllowed("")).toBe(false);
  });
});
