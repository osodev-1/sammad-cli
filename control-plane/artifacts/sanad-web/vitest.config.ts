import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": rootDir },
  },
  // Next compiles JSX with the AUTOMATIC runtime; esbuild here defaults to the
  // classic one, which emits bare `React.createElement` and throws
  // "React is not defined" the moment a test renders a component. Only
  // component tests hit this — logic-only suites never transform a .tsx.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup-env.ts"],
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
