import { describe, it, expect, afterEach } from "vitest";
import { coderPanelEmails, isCoderPanelAllowed } from "@/lib/auth/coder";

describe("coder panel allowlist", () => {
  const original = process.env.SANAD_CODER_PANEL_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.SANAD_CODER_PANEL_EMAILS;
    else process.env.SANAD_CODER_PANEL_EMAILS = original;
  });

  it("parses, trims, lowercases and drops empty entries", () => {
    process.env.SANAD_CODER_PANEL_EMAILS = " Foo@Example.com , bar@x.io ,,";
    expect(coderPanelEmails()).toEqual(["foo@example.com", "bar@x.io"]);
  });

  it("FAILS CLOSED: empty or unset allowlist denies everyone", () => {
    delete process.env.SANAD_CODER_PANEL_EMAILS;
    expect(isCoderPanelAllowed("anyone@example.com")).toBe(false);
    process.env.SANAD_CODER_PANEL_EMAILS = "";
    expect(isCoderPanelAllowed("anyone@example.com")).toBe(false);
  });

  it("matches case-insensitively and denies null/undefined", () => {
    process.env.SANAD_CODER_PANEL_EMAILS = "omar@example.com";
    expect(isCoderPanelAllowed("OMAR@example.com")).toBe(true);
    expect(isCoderPanelAllowed("other@example.com")).toBe(false);
    expect(isCoderPanelAllowed(null)).toBe(false);
    expect(isCoderPanelAllowed(undefined)).toBe(false);
  });
});
