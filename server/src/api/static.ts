import { readFileSync } from "node:fs";
import { normalize, join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Static web UI server with SPA fallback that works BOTH unpackaged and inside a
 * `pkg` single-file executable.
 *
 * Why not @fastify/static here: under pkg, the web assets live in a virtual
 * snapshot filesystem. pkg patches `fs.readFileSync` to read from the snapshot,
 * but @fastify/send (used by @fastify/static) relies on streaming/stat calls that
 * do not resolve nested snapshot paths reliably — root index works, nested
 * /assets/*.js 404. Reading bytes with readFileSync sidesteps that entirely.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function readAsset(root: string, relPath: string): Buffer | null {
  // Prevent path traversal: normalize and reject anything escaping the root.
  const safeRel = normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  if (safeRel.includes("..")) return null;
  const full = join(root, safeRel);
  try {
    return readFileSync(full);
  } catch {
    return null;
  }
}

/**
 * Register static serving for the built web UI at `root`, with an SPA fallback to
 * index.html for any non-/api route. Returns whether assets were found.
 */
export function registerWebStatic(fastify: FastifyInstance, root: string): boolean {
  const index = readAsset(root, "index.html");
  if (!index) return false;

  // Explicit GET handler for real files, then a catch-all SPA fallback.
  fastify.setNotFoundHandler((req, reply) => {
    const url = (req.raw.url ?? "/").split("?")[0]!;
    if (url.startsWith("/api/") || req.method !== "GET") {
      reply.code(404).send({ error: "not_found", message: "unknown route" });
      return;
    }

    // Try to serve the requested path as a real file (only if it has an extension).
    const rel = decodeURIComponent(url.replace(/^\/+/, "")) || "index.html";
    const looksLikeFile = rel.split("/").pop()?.includes(".");
    if (looksLikeFile) {
      const bytes = readAsset(root, rel);
      if (bytes) {
        reply.header("content-type", contentTypeFor(rel)).send(bytes);
        return;
      }
      // A missing real asset (e.g. /favicon.png) -> 404, not the SPA shell.
      reply.code(404).send({ error: "not_found", message: "asset not found" });
      return;
    }

    // Client-side route -> serve the SPA shell.
    reply.header("content-type", "text/html; charset=utf-8").send(index);
  });

  // Serve the root index explicitly (the not-found handler covers everything else).
  fastify.get("/", async (_req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return index;
  });

  return true;
}
