import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { storedOutput } from "./exec.js";
import { addProof, meets, repoState, saveGate, stepOf, type Gate } from "./gate.js";
import { redact } from "./secrets.js";

const MAX_REQUESTS = 200;
const MIN_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
const STORED_BODY = 2_000;
/** Shorter than this, masking would erase unrelated text. */
const MIN_FIELD_LENGTH = 8;
const FORM_RE = /^[^\s=&]+=[^\s]*$/;
const METHOD_OVERRIDE_RE = /^x-(http-)?method(-override)?$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface HttpInput {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  expectStatus?: number | undefined;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".proofbench", "config.json");
}

function repoKey(path: string): string {
  let abs = resolve(path);
  try {
    abs = realpathSync.native(abs);
  } catch {
    // path does not exist: keep the resolved form
  }
  const out = abs.split("\\").join("/").replace(/\/+$/, "");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/** Only the user's file is authoritative, never a file from the repo. Missing or unreadable: no host. */
export function stagingHosts(repo: string, configPath: string = defaultConfigPath()): string[] {
  let repos: unknown;
  try {
    repos = (JSON.parse(readFileSync(configPath, "utf8")) as { repos?: unknown }).repos;
  } catch {
    return [];
  }
  if (typeof repos !== "object" || repos === null) return [];
  const wanted = repoKey(repo);
  const entry = Object.entries(repos).find(([key]) => repoKey(key) === wanted)?.[1] as { stagingHosts?: unknown } | undefined;
  return Array.isArray(entry?.stagingHosts) ? entry.stagingHosts.filter((h): h is string => typeof h === "string").map((h) => h.toLowerCase()) : [];
}

/** Returns the accepted URL, or throws: no request is sent on a refusal. */
export function checkTarget(rawUrl: string, hosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password) throw new Error("URL refused: credentials in the URL");
  if (host.includes("prod")) throw new Error(`Host refused: never production (${host})`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(host))) {
    throw new Error("URL refused: HTTPS required outside localhost");
  }
  if (!hosts.includes(host) && !hosts.includes(url.host.toLowerCase())) throw new Error(`Host refused, not in stagingHosts: ${host}`);
  return url;
}

/** The name gives the secret away: the value then counts at any length. */
const SENSITIVE_FIELD_RE = /jwt|session|refresh|password|passwd|token|secret/i;
const FIELD_IN_TEXT_RE = /(["']?[\w-]*(?:jwt|session|refresh|password|passwd)[\w-]*["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi;

function entries(value: unknown, key: string): [string, string][] {
  if (typeof value === "string") return [[key, value]];
  if (typeof value === "number") return [[key, String(value)]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => entries(v, Array.isArray(value) ? key : k));
}

function bodyFields(body: string): [string, string][] {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) return entries(parsed, "");
  } catch {
    // not JSON
  }
  return FORM_RE.test(body) ? [...new URLSearchParams(body).entries()] : [["", body]];
}

/** What the request sent, and which a response or an error may echo back as is: raw, or URL-encoded. */
export function requestSecrets(url: URL, body: string | undefined, headers: Record<string, string> | undefined): string[] {
  const fields = [...url.searchParams.entries(), ...(body === undefined ? [] : bodyFields(body))]
    .filter(([key, value]) => value.length >= MIN_FIELD_LENGTH || SENSITIVE_FIELD_RE.test(key))
    .map(([, value]) => value);
  const encoded = fields.map(encodeURIComponent);
  return [...new Set([...fields, ...encoded, ...encoded.map((v) => v.replaceAll("%20", "+")), ...Object.values(headers ?? {})])];
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (let total = 0; total < MAX_BODY_BYTES; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}

/** One request at a time and one per second for the whole server, whatever the gate. */
export function createLimiter(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  let last = 0;
  return (work) => {
    const running = tail.then(async () => {
      await new Promise((r) => setTimeout(r, Math.max(0, last + MIN_INTERVAL_MS - Date.now())));
      last = Date.now();
      return work();
    });
    tail = running.catch(() => undefined);
    return running;
  };
}

export async function httpProbe(gate: Gate, input: HttpInput, limiter: ReturnType<typeof createLimiter>, opts: { configPath?: string | undefined; root?: string | undefined }) {
  const step = stepOf(gate, "api_staging");
  if (!gate.authorizedBy) throw new Error("Network test refused: authorizedBy missing from gate_start");
  const url = checkTarget(input.url, stagingHosts(gate.repo, opts.configPath));
  if (Object.keys(input.headers ?? {}).some((h) => METHOD_OVERRIDE_RE.test(h))) throw new Error("Header refused: it would change the method, GET or POST only");
  if (gate.httpCount >= MAX_REQUESTS) throw new Error(`Limit reached: ${MAX_REQUESTS} requests per gate`);
  gate.httpCount += 1;
  saveGate(gate, opts.root);

  const sent = requestSecrets(url, input.body, input.headers);
  const state = await repoState(gate.repo, gate.watchIgnored);
  // The request as recorded: without parameters, which often carry a token.
  const shown = [input.method, `${url.origin}${url.pathname}${url.search ? "?[masked]" : ""}`];
  const res = await limiter(() =>
    fetch(url, {
      method: input.method,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.body === undefined ? {} : { body: input.body }),
    }).then(async (r) => ({ status: r.status, text: await readCapped(r) })),
  ).catch((e: unknown) => ({ status: null, text: String((e as Error).message) }));

  const body = storedOutput(redact(res.text, sent).replace(FIELD_IN_TEXT_RE, "$1[masked]"), STORED_BODY);
  const asExpected = res.status !== null && (input.expectStatus === undefined ? res.status < 500 : res.status === input.expectStatus);
  const wanted = input.expectStatus === undefined ? "below 500" : String(input.expectStatus);
  const proof = addProof(gate, step, state, {
    command: shown,
    exitCode: res.status === null ? null : asExpected ? 0 : 1,
    output: `HTTP ${String(res.status)}\n${body}`,
    ...(res.status === null ? { failure: body } : {}),
    ...(asExpected ? {} : { findings: [{ rule: "http", detail: `${shown.join(" ")}: ${res.status === null ? "no response" : `${res.status}, expected ${wanted}`}` }] }),
  });
  return { step: step.id, status: res.status, exitCode: proof.exitCode, ok: meets(step, proof), body, requests: gate.httpCount };
}
