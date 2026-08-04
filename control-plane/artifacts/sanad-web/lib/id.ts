import { randomUUID } from "crypto";

/** Generate a short URL-safe ID (UUID without hyphens). */
export function nanoid(): string {
  return randomUUID().replace(/-/g, "");
}
