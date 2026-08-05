import { randomUUID } from "node:crypto";
import { logger } from "./logger";

/**
 * Report a served completion to the control plane's usage ingest
 * (POST /api/v1/usage) using the same runtime token that authorized the call —
 * that token is what identifies the org. Fire-and-forget: metering must never
 * block or fail the model response. `eventId` is a fresh idempotency key so a
 * retried report can't double-bill.
 */
export function reportUsage(
  runtimeToken: string,
  modelAlias: string,
  tokensIn: number,
  tokensOut: number
): void {
  const base = process.env.CONTROL_PLANE_URL;
  if (!base) {
    logger.warn("CONTROL_PLANE_URL not set — skipping usage report");
    return;
  }

  const url = `${base.replace(/\/+$/, "")}/api/v1/usage`;

  void fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runtimeToken}`,
    },
    body: JSON.stringify({
      modelAlias,
      tokensIn,
      tokensOut,
      eventId: randomUUID(),
    }),
  })
    .then((res) => {
      if (!res.ok) {
        logger.warn({ status: res.status, modelAlias }, "usage report non-2xx");
      }
    })
    .catch((err) => {
      logger.error({ err, modelAlias }, "usage report failed");
    });
}
