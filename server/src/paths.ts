import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Path resolution that works both when running from source/`dist/` AND when the
 * app is bundled into a single executable by `pkg`.
 *
 * Under pkg, `process.pkg` is set and the bundled snapshot lives at a virtual
 * path (process.execPath's dir is the REAL exe location on disk). We therefore:
 *   - read bundled, read-only assets (the web UI) from the snapshot via __dirname
 *   - write mutable data (state.json) NEXT TO the executable, never into the
 *     read-only snapshot or a temp dir.
 */

export function isPackaged(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
}

/**
 * Directory of the current module. Resolved in a way that survives BOTH:
 *   - the ESM dev/dist build (import.meta.url is set), and
 *   - the esbuild->CJS bundle used by pkg (import.meta.url is empty there, but
 *     CJS `__dirname` is provided and pkg points it at the snapshot dir).
 */
function moduleDir(): string {
  // Inside a pkg executable the bundled entry lives in the virtual snapshot at
  // process.argv[1] (e.g. /snapshot/dist-pc/bundle.cjs); its dir is where the
  // `assets` (web/) are mounted. __dirname inside the bundle resolves to the same.
  if (isPackaged() && process.argv[1]) {
    return dirname(process.argv[1]);
  }
  try {
    const url = import.meta?.url;
    if (url) return dirname(fileURLToPath(url));
  } catch {
    // import.meta not available (CJS) — fall through.
  }
  // Last resort: directory of the running executable.
  return dirname(process.execPath);
}

const here = moduleDir();

/**
 * Locate the built web UI directory (containing index.html). Tries, in order:
 *   1. WEB_DIR env override
 *   2. a `web` dir next to this module (used by pkg: assets are snapshotted here
 *      as `<snapshot>/web`)
 *   3. ../web/dist relative to the source/dist layout (repo checkout)
 *   4. ./web/dist next to the executable
 * Returns the first that exists, or the best guess (#2) so the static plugin can
 * still be registered (it will simply 404 until assets exist).
 */
export function resolveWebDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  if (env.WEB_DIR) candidates.push(resolve(env.WEB_DIR));
  // Bundled assets (pkg) live next to the compiled entry as `web`.
  candidates.push(join(here, "web"));
  candidates.push(join(here, "..", "web"));
  // Repo checkout: server/dist/.. -> server/.. -> web/dist
  candidates.push(resolve(here, "..", "..", "web", "dist"));
  candidates.push(resolve(here, "..", "..", "..", "web", "dist"));
  // Next to the executable.
  candidates.push(resolve(dirname(process.execPath), "web"));

  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return candidates[1]!;
}

/**
 * Directory for mutable persisted data. When packaged, place it NEXT TO the
 * executable (so users find/back it up easily and it survives across runs).
 * Otherwise use the repo-local `data/` dir. Overridable via DATA_DIR.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATA_DIR) return resolve(env.DATA_DIR);
  if (isPackaged()) return resolve(dirname(process.execPath), "qr-data");
  return resolve(here, "..", "data");
}
