import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { build as esbuild } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(artifactDir, "dist");

await rm(distDir, { recursive: true, force: true });
await esbuild({
  entryPoints: [path.resolve(artifactDir, "src/index.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: distDir,
  outExtension: { ".js": ".mjs" },
  sourcemap: true,
  logLevel: "info",
  banner: {
    // http-proxy is CJS; give the ESM bundle a require shim.
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
