import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CACHE_TTL_MS = 24 * 3_600_000;
export const CACHE_MAX_BYTES = 50 * 1024 * 1024;

export interface CacheOptions {
  dir?: string;
  ttlMs?: number;
  maxBytes?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface Entry {
  url: string;
  fetchedAt: number;
  status: number;
  body: string;
}

export function defaultCacheDir(): string {
  return join(homedir(), ".proofbench", "docs-cache");
}

/** On-disk cache of successful GET bodies. Every operation is best effort: a broken cache never breaks a tool. */
export class DiskCache {
  readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(opts: CacheOptions = {}) {
    this.dir = opts.dir ?? defaultCacheDir();
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this.maxBytes = opts.maxBytes ?? CACHE_MAX_BYTES;
    this.now = opts.now ?? Date.now;
  }

  private file(url: string): string {
    return join(this.dir, createHash("sha256").update(url).digest("hex") + ".json");
  }

  get(url: string): Entry | null {
    try {
      const f = this.file(url);
      if (!existsSync(f)) return null;
      const e = JSON.parse(readFileSync(f, "utf8")) as Entry;
      if (e.url !== url || typeof e.body !== "string" || typeof e.fetchedAt !== "number") return null;
      if (this.now() - e.fetchedAt > this.ttlMs) {
        unlinkSync(f);
        return null;
      }
      return e;
    } catch {
      return null;
    }
  }

  set(url: string, status: number, body: string): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const f = this.file(url);
      const entry: Entry = { url, fetchedAt: this.now(), status, body };
      writeFileSync(f, JSON.stringify(entry), { mode: 0o600 });
      try {
        chmodSync(f, 0o600);
      } catch {
        // not supported on every OS
      }
      try {
        const t = entry.fetchedAt / 1000;
        utimesSync(f, t, t);
      } catch {
        // ordering falls back to the real mtime
      }
      this.evict();
    } catch {
      // best effort
    }
  }

  /** Deletes the oldest entries (by fetch time) until the total size is within the limit. */
  evict(): void {
    try {
      const files = readdirSync(this.dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => {
          const p = join(this.dir, n);
          const s = statSync(p);
          return { p, size: s.size, t: s.mtimeMs };
        })
        .sort((a, b) => a.t - b.t);
      let total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) {
        if (total <= this.maxBytes) break;
        unlinkSync(f.p);
        total -= f.size;
      }
    } catch {
      // best effort
    }
  }
}
