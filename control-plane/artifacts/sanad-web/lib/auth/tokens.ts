import { randomBytes, createHash } from "crypto";

/** Generate a high-entropy opaque token with a human-readable prefix. */
export const newToken = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

/** SHA-256 hash of a token — used for at-rest storage. */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
