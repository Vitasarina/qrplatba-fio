// Build a single self-contained executable for the PC desktop variant.
//
//   1. esbuild: bundle the ESM server (src/index.ts) -> dist-pc/bundle.cjs (CommonJS)
//   2. copy the built web UI (web/dist) -> dist-pc/web  (bundled into the exe as assets)
//   3. pkg: produce win-x64 (+ linux-x64) binaries in dist-pc/
//
// Run after building the web UI (npm run build:web). The npm "build:exe" script
// chains those steps.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const outDir = join(serverDir, "dist-pc");
const webDist = resolve(serverDir, "..", "web", "dist");

function log(msg) {
  process.stdout.write(`[build-exe] ${msg}\n`);
}

// ---- clean ----
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ---- 1. bundle server to CJS ----
log("bundling server -> dist-pc/bundle.cjs");
await build({
  entryPoints: [join(serverDir, "src", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: join(outDir, "bundle.cjs"),
  // qrcode/decimal.js/fastify are pure-JS and bundle cleanly. Nothing native.
  banner: {
    js: "/* QR Platba PC desktop server — bundled by esbuild for pkg */",
  },
  logLevel: "info",
});

// ---- 2. stage the web UI next to the bundle (pkg snapshots it as assets) ----
if (!existsSync(join(webDist, "index.html"))) {
  log(`WARNING: web build not found at ${webDist}. Run "npm run build:web" first.`);
  log("The exe will still build but will serve API only until assets exist.");
} else {
  log("copying web/dist -> dist-pc/web");
  cpSync(webDist, join(outDir, "web"), { recursive: true });
}

// ---- 3. write a minimal package.json for pkg (assets + targets) ----
const pkgManifest = {
  name: "qr-payments-pc",
  version: "1.0.0",
  bin: "bundle.cjs",
  pkg: {
    // Snapshot the web assets so @fastify/static can read them inside the exe.
    assets: ["web/**/*"],
    targets: ["node18-win-x64", "node18-linux-x64"],
    outputPath: ".",
  },
};
writeFileSync(join(outDir, "package.json"), JSON.stringify(pkgManifest, null, 2));

// ---- 4. run pkg ----
const targets = process.env.PKG_TARGETS || "node18-win-x64,node18-linux-x64";
log(`running pkg for: ${targets}`);
const pkgBin = join(serverDir, "node_modules", ".bin", "pkg");
const res = spawnSync(
  pkgBin,
  [
    "bundle.cjs",
    "--targets",
    targets,
    "--output",
    "qr-payments",
    "--config",
    "package.json",
  ],
  { cwd: outDir, stdio: "inherit" },
);

if (res.status !== 0) {
  log(`pkg failed with exit code ${res.status}`);
  process.exit(res.status ?? 1);
}
log(`done. Binaries in ${outDir}`);
