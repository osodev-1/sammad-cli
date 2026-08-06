import { describe, it, expect } from "vitest";
import {
  classifyConflict,
  encodeControl,
  isBlockedCode,
  parseServerControl,
  parseSessionGrant,
} from "@/lib/terminal/protocol";

describe("terminal protocol", () => {
  it("encodes client control frames as JSON", () => {
    expect(JSON.parse(encodeControl({ type: "ping" }))).toEqual({ type: "ping" });
    expect(
      JSON.parse(encodeControl({ type: "auth", ticket: "tt_x", cols: 100, rows: 30 }))
    ).toEqual({ type: "auth", ticket: "tt_x", cols: 100, rows: 30 });
  });

  it("parses every server frame type", () => {
    expect(
      parseServerControl('{"type":"ready","userId":"u1","cols":100,"rows":30}')
    ).toEqual({ type: "ready", userId: "u1", cols: 100, rows: 30 });
    expect(parseServerControl('{"type":"pong"}')).toEqual({ type: "pong" });
    expect(
      parseServerControl('{"type":"warning","reason":"idle","secondsLeft":300}')
    ).toEqual({ type: "warning", reason: "idle", secondsLeft: 300 });
    expect(parseServerControl('{"type":"exit","code":0}')).toEqual({
      type: "exit",
      code: 0,
    });
    expect(parseServerControl('{"type":"exit","code":null}')).toEqual({
      type: "exit",
      code: null,
    });
    expect(parseServerControl('{"type":"error","code":"invalid_ticket"}')).toEqual({
      type: "error",
      code: "invalid_ticket",
      message: undefined,
    });
  });

  it("returns null for malformed or unknown frames (never throws)", () => {
    expect(parseServerControl("not json")).toBeNull();
    expect(parseServerControl("[1,2]")).toBeNull();
    expect(parseServerControl('{"type":"mystery"}')).toBeNull();
    expect(parseServerControl('{"type":"ready"}')).toBeNull(); // missing userId
    expect(parseServerControl('{"type":"error"}')).toBeNull(); // missing code
  });

  it("classifies conflict codes", () => {
    expect(classifyConflict("session_replaced")).toBe("taken_over");
    expect(classifyConflict("session_exists")).toBe("refused");
    expect(classifyConflict("idle_timeout")).toBeNull();
  });

  it("recognizes the blocked codes the session route can return", () => {
    expect(isBlockedCode("terminal_not_enabled")).toBe(true);
    expect(isBlockedCode("no_plan")).toBe(true);
    expect(isBlockedCode("no_seat")).toBe(true);
    expect(isBlockedCode("quota_exceeded")).toBe(false);
    expect(isBlockedCode(undefined)).toBe(false);
  });

  it("parses the session grant envelope", () => {
    expect(
      parseSessionGrant({ data: { ticket: "tt_x", wsUrl: "wss://t/ws", expiresIn: 60 } })
    ).toEqual({ ticket: "tt_x", wsUrl: "wss://t/ws" });
    expect(parseSessionGrant({ data: { ticket: "tt_x" } })).toBeNull();
    expect(parseSessionGrant(null)).toBeNull();
    expect(parseSessionGrant({})).toBeNull();
  });
});
