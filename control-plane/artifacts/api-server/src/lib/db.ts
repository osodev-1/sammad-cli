import { pool } from "@workspace/db";
import { logger } from "./logger";

// A pg Pool emits 'error' when an *idle* pooled client fails — e.g. the database
// restarts, is failed over, or drops the connection. Left unhandled, that event
// crashes the whole process. Absorb and log it; the pool transparently
// re-establishes connections on the next query.
pool.on("error", (err) => {
  logger.error({ err }, "postgres pool idle-client error");
});

export { pool };
