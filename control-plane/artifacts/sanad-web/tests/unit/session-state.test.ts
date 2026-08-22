import { describe, it, expect } from "vitest";
import {
  EMPTY_SESSION_STATE,
  SESSION_STATE_VERSION,
  parseSessionState,
  sessionUiState,
} from "@/lib/sessions/state";

describe("session UI state", () => {
  it("round-trips a full valid state", () => {
    const state = {
      v: SESSION_STATE_VERSION,
      terminals: [{ id: "term-1", label: "Agent" }],
      fileTabs: [{ path: "src/app.ts" }],
      viewTabs: [{ url: "site/index.html", alias: "Home" }],
      active: "src/app.ts",
      drawerOpen: true,
    };
    expect(parseSessionState(state)).toEqual(state);
  });

  it("degrades unknown/old blobs to an empty session, never throws", () => {
    expect(parseSessionState(null)).toEqual(EMPTY_SESSION_STATE);
    expect(parseSessionState({ v: 999 })).toEqual(EMPTY_SESSION_STATE);
    expect(parseSessionState("garbage")).toEqual(EMPTY_SESSION_STATE);
    expect(parseSessionState({ v: 1, terminals: "nope" })).toEqual(
      EMPTY_SESSION_STATE,
    );
  });

  it("rejects oversized tab lists (guards the persisted blob)", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      path: `f${i}.ts`,
    }));
    const parsed = sessionUiState.safeParse({ v: 1, fileTabs: tooMany });
    expect(parsed.success).toBe(false);
  });

  it("aliases are optional and default active is null", () => {
    const parsed = parseSessionState({ v: 1, fileTabs: [{ path: "x.ts" }] });
    expect(parsed.fileTabs[0].alias).toBeUndefined();
    expect(parsed.active).toBeNull();
  });

  it("carries an architect transcript; pre-S9 blobs parse without one", () => {
    const withChat = parseSessionState({
      v: 1,
      architect: [
        { role: "user", text: "add a code review skill" },
        {
          role: "assistant",
          blocks: [
            { kind: "text", text: "Here's a plan." },
            { kind: "tool", label: "BlueprintGraph" },
            {
              kind: "plan",
              summary: "Create Skill \"Code Review\"",
              files: 2,
              state: "applied",
              txId: "tx_1",
            },
          ],
        },
      ],
    });
    expect(withChat.architect).toHaveLength(2);
    // Pre-S9 blob: absent field stays absent, everything else intact.
    expect(parseSessionState({ v: 1 }).architect).toBeUndefined();
    // A malformed transcript degrades the whole blob (record, not source of truth).
    expect(
      parseSessionState({ v: 1, architect: [{ role: "wizard" }] }),
    ).toEqual(EMPTY_SESSION_STATE);
  });

  it("carries a coder transcript; pre-P1b blobs parse without one", () => {
    const withCoder = parseSessionState({
      v: 1,
      coder: {
        conversationId: "coder-1",
        transcript: [
          { role: "user", text: "write a function" },
          {
            role: "assistant",
            blocks: [
              { kind: "text", text: "Here's the code." },
              { kind: "tool", label: "FileWrite" },
              {
                kind: "request",
                requestId: "req-1",
                requestType: "approval",
                summary: "Write to src/app.ts",
                state: "resolved",
                outcome: "approve",
              },
            ],
          },
        ],
      },
    });
    expect(withCoder.coder).toBeDefined();
    expect(withCoder.coder?.transcript).toHaveLength(2);
    // Pre-P1b blob: absent coder field stays absent, everything else intact.
    expect(parseSessionState({ v: 1 }).coder).toBeUndefined();
  });

  it("carries coder.lastInterruptedTurnId (P3 Task 4 Fix B); pre-Task-4 blobs parse without one", () => {
    const withTurnId = parseSessionState({
      v: 1,
      coder: {
        conversationId: "coder-1",
        lastInterruptedTurnId: "t_1",
      },
    });
    expect(withTurnId.coder?.lastInterruptedTurnId).toBe("t_1");
    // Pre-Task-4 blob (conversationId/transcript only, no lastInterruptedTurnId
    // field at all): absent field stays absent, everything else intact.
    const preTask4 = parseSessionState({
      v: 1,
      coder: { conversationId: "coder-1" },
    });
    expect(preTask4.coder?.conversationId).toBe("coder-1");
    expect(preTask4.coder?.lastInterruptedTurnId).toBeUndefined();
    // An oversized turnId degrades the whole blob (same posture as every
    // other coder field here — the blob is a record, not a source of truth).
    expect(
      parseSessionState({
        v: 1,
        coder: { lastInterruptedTurnId: "x".repeat(129) },
      }),
    ).toEqual(EMPTY_SESSION_STATE);
  });

  it("rejects pending request blocks in coder transcript; entire blob degrades to EMPTY_SESSION_STATE", () => {
    // A blob with a pending request MUST degrade completely (never-persist-pending invariant).
    const withPending = parseSessionState({
      v: 1,
      fileTabs: [{ path: "src/app.ts" }],
      coder: {
        transcript: [
          { role: "user", text: "write a function" },
          {
            role: "assistant",
            blocks: [
              {
                kind: "request",
                requestId: "req-1",
                requestType: "approval",
                summary: "Write to src/app.ts",
                state: "pending",
              },
            ],
          },
        ],
      },
    });
    expect(withPending).toEqual(EMPTY_SESSION_STATE);
  });
});
