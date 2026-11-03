const SECRET_ENV = new Set(["GITLAB_TOKEN", "JIRA_API_TOKEN", "JIRA_EMAIL"]);
const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|KEY|(^|_)(PAT|PASS|AUTH)(_|$)/;
const USERINFO_RE = /:\/\/[^\s/@]+@/;
const REDACTED = "[masked]";
/** Shorter than this, masking would erase unrelated text. */
const MIN_SECRET_LENGTH = 8;

export function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_ENV.has(upper) || SECRET_NAME_RE.test(upper);
}

/** A variable is secret by its name, or because its value is a URL with credentials. */
export function isSecretEnv(name: string, value: string | undefined): boolean {
  return isSecretName(name) || (value !== undefined && USERINFO_RE.test(value));
}

export interface SecretPattern {
  kind: string;
  /** Group 1 is the secret value. */
  re: RegExp;
  /** Public characters left visible: a format prefix, never a piece of the value. */
  visible: number;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "aws", re: /\b(AKIA[0-9A-Z]{16})\b/g, visible: 4 },
  { kind: "github", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g, visible: 4 },
  { kind: "gitlab", re: /\b(glpat-[A-Za-z0-9_-]{20,})/g, visible: 6 },
  { kind: "slack", re: /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g, visible: 5 },
  { kind: "google", re: /\b(AIza[0-9A-Za-z_-]{35})/g, visible: 4 },
  { kind: "stripe", re: /\b(sk_live_[0-9a-zA-Z]{24,})/g, visible: 8 },
  { kind: "anthropic", re: /\b(sk-ant-[A-Za-z0-9_-]{20,})/g, visible: 7 },
  { kind: "openai", re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{32,})/g, visible: 3 },
  { kind: "private-key", re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g, visible: 10 },
  { kind: "signing", re: /\b(?:storePassword|keyPassword)\s*[=(]?\s*["']([^"']+)["']/g, visible: 0 },
  { kind: "signing", re: /\bstoreFile\s*[=(]?\s*(?:file\(\s*)?["']([^"']+)["']/g, visible: 0 },
  {
    kind: "assigned",
    re: /(?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    visible: 0,
  },
];

/** Prepares the `git grep` filter, deliberately broad: `SECRET_PATTERNS` decides afterwards. */
export const GREP_PREFILTER =
  "AKIA|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AIza|sk_live_|sk-|PRIVATE KEY|api[_-]?key|secret|password|passwd|token|storeFile";

/** Unquoted `name=value`: only where it is the file's syntax, otherwise all code would match. */
export const UNQUOTED_RE = /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*([^\s"'#]{4,})/gi;
export const CONFIG_FILE_RE = /\.(properties|ya?ml|conf|ini|toml|cfg)$/;
/** Everything in them is a value to keep out of the repo, except templates. */
export const VALUE_FILE_RE = /(^|\/)(\.env(\.[^/]*)?|key\.properties|local\.properties)$/;
export const TEMPLATE_FILE_RE = /\.(example|sample|template|dist)$/;
export const VALUE_LINE_RE = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.+?)\s*$/;
export const HARMLESS_KEY_RE = /^(sdk\.dir|ndk\.dir|cmake\.dir)$/;
export const KEYSTORE_RE = /\.(jks|keystore)$/i;

/** Exact match: a real password may start with "test". */
const PLACEHOLDER_RE = /^(\$\{.*\}|\$[A-Z_]+|<.*>|%.*%|\{\{.*\}\}|x{4,}|\*+|your[_-].*|changeme|change_me|placeholder|example|test|dummy|sample|null|none)$/i;

export function maskValue(value: string, visible: number): string {
  return `${value.slice(0, visible)}***(${value.length})`;
}

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value);
}

function maskPatterns(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, p) => out.replace(p.re, (match, value: string) => match.replace(value, () => maskValue(value, p.visible))),
    text,
  );
}

const CONTEXT_MASKS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "-----BEGIN PRIVATE KEY-----[masked]"],
  [/\b(authorization["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, "$1[masked]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [masked]"],
  [/(:\/\/)[^\s/@]+@/g, "$1[masked]@"],
  [/\b(password|passwd|pwd|pass|secret|token|api[_-]?key)(["']?\s*[=:]\s*)(?!\[masked)[^\s"',;&)]+/gi, "$1$2[masked]"],
];

const SECRET_FLAG_RE = /^--?[\w-]*(token|password|passwd|pass|secret|key|auth)[\w-]*$/i;

/** A secret option value, attached (`--token=x`) or as the next argument. */
export function maskArgv(command: readonly string[]): string[] {
  return command.map((arg, i) => {
    if (i > 0 && SECRET_FLAG_RE.test(command[i - 1] as string) && !arg.startsWith("-")) return REDACTED;
    const [name, value] = arg.split(/=(.*)/s);
    return value !== undefined && SECRET_FLAG_RE.test(name as string) ? `${name}=${REDACTED}` : redact(arg);
  });
}

/**
 * Masks the values of secret variables, longest first, the `extra` values given by the caller,
 * then anything shaped like a known key.
 */
export function redact(text: string, extra: readonly string[] = []): string {
  const values = Object.entries(process.env)
    .filter(([k, v]) => isSecretEnv(k, v) && v !== undefined && v.length >= MIN_SECRET_LENGTH)
    .map(([, v]) => v as string)
    .concat(extra.filter((v) => v.length >= 3))
    .sort((a, b) => b.length - a.length);
  const known = values.reduce((out, value) => out.split(value).join(REDACTED), text);
  // Context first: masking a private key's header would hide where its body starts.
  return maskPatterns(CONTEXT_MASKS.reduce((out, [re, to]) => out.replace(re, to), known));
}
