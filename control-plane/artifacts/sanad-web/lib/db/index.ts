import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Standard Postgres (Railway) over a pooled TCP connection. The control plane
// runs as a long-lived server, so a shared pool is the right model. The pool is
// lazy — it connects on first query — so importing this module does not require
// the database to be reachable at build or test time.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
