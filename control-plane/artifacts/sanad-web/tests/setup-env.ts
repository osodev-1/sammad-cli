// Test-environment defaults.
//
// The app builds its Postgres pool from DATABASE_URL. The pool is lazy, so
// importing modules that reach the db doesn't require it — but default a
// throwaway value anyway so anything that reads DATABASE_URL at import time
// can't fail in CI. Suites that exercise the database mock @/lib/db; this never
// opens a real connection.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
