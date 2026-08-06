/**
 * The compute-migration flag. Exactly two call sites branch on this — the
 * terminal session route and workspaceFetch — via this one helper, so they
 * can never disagree. Default stays "railway" until Phase B verification.
 */
export type ComputeMode = "railway" | "aws";

export function computeMode(): ComputeMode {
  return process.env.SANAD_COMPUTE === "aws" ? "aws" : "railway";
}
