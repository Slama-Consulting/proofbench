import { dirOf, join, type Dependency, type FileAccess } from "./types.js";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Minimal indentation-based YAML reader (mappings only; list items and comments are ignored). Enough for pnpm-lock.yaml. */
export function parseYamlMap(text: string): Obj {
  const root: Obj = {};
  const stack: { indent: number; node: Obj }[] = [{ indent: -1, node: root }];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#") || raw.trim().startsWith("- ")) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    let key: string;
    let rest: string;
    if (t[0] === '"' || t[0] === "'") {
      const end = t.indexOf(t[0], 1);
      if (end < 0 || t[end + 1] !== ":") continue;
      key = t.slice(1, end);
      rest = t.slice(end + 2);
    } else {
      const m = /^(.+?):(?:\s+(.*))?$/.exec(t);
      if (!m) continue;
      key = m[1]!;
      rest = m[2] ?? "";
    }
    const value = rest.replace(/\s+#.*$/, "").trim();
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    if (value === "") {
      const child: Obj = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return root;
}

function cleanPnpmVersion(v: string): string {
  return v.replace(/^\//, "").replace(/\(.*$/, "").replace(/_.*$/, "");
}

/** Resolves exact versions from package-lock.json, pnpm-lock.yaml or yarn.lock, looking upward from the package directory. */
export class NpmLocks {
  private readonly cache = new Map<string, unknown>();
  constructor(private readonly files: FileAccess) {}

  private memo<T>(key: string, make: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key) as T;
  }

  lookup(pkgDir: string, name: string, spec: string): string | undefined {
    let dir = pkgDir;
    for (;;) {
      const v =
        this.fromPackageLock(dir, pkgDir, name) ?? this.fromPnpm(dir, pkgDir, name) ?? this.fromYarn(dir, name, spec);
      if (v) return v;
      if (!dir) return undefined;
      dir = dirOf(dir);
    }
  }

  private fromPackageLock(lockDir: string, pkgDir: string, name: string): string | undefined {
    const file = join(lockDir, "package-lock.json");
    if (!this.files.has(file)) return undefined;
    const lock = this.memo(file, () => {
      try {
        return JSON.parse(this.files.read(file) ?? "") as Obj;
      } catch {
        return null;
      }
    }) as Obj | null;
    if (!lock) return undefined;
    const rel = pkgDir === lockDir ? "" : pkgDir.slice(lockDir ? lockDir.length + 1 : 0);
    const packages = isObj(lock.packages) ? lock.packages : undefined;
    if (packages) {
      for (const key of [rel ? `${rel}/node_modules/${name}` : "", `node_modules/${name}`]) {
        if (!key) continue;
        const e = packages[key];
        if (isObj(e) && typeof e.version === "string") return e.version;
      }
    }
    const deps = isObj(lock.dependencies) ? lock.dependencies : undefined;
    const e = deps?.[name];
    return isObj(e) && typeof e.version === "string" ? e.version : undefined;
  }

  private fromPnpm(lockDir: string, pkgDir: string, name: string): string | undefined {
    const file = join(lockDir, "pnpm-lock.yaml");
    if (!this.files.has(file)) return undefined;
    const lock = this.memo(file, () => parseYamlMap(this.files.read(file) ?? ""));
    const rel = pkgDir === lockDir ? "." : pkgDir.slice(lockDir ? lockDir.length + 1 : 0);
    const importers = isObj(lock.importers) ? lock.importers : undefined;
    const scopes: Obj[] = [];
    if (importers && isObj(importers[rel])) scopes.push(importers[rel] as Obj);
    else if (!importers) scopes.push(lock);
    for (const s of scopes) {
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const group = s[section];
        if (!isObj(group)) continue;
        const e = group[name];
        if (typeof e === "string") return cleanPnpmVersion(e);
        if (isObj(e) && typeof e.version === "string") return cleanPnpmVersion(e.version);
      }
    }
    return undefined;
  }

  private fromYarn(lockDir: string, name: string, spec: string): string | undefined {
    const file = join(lockDir, "yarn.lock");
    if (!this.files.has(file)) return undefined;
    const map = this.memo(file, () => {
      const out = new Map<string, string>();
      const lines = (this.files.read(file) ?? "").replace(/\r\n?/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line || line.startsWith(" ") || line.startsWith("#") || !line.endsWith(":")) continue;
        const keys = line
          .slice(0, -1)
          .split(",")
          .map((k) => k.trim().replace(/^["']|["']$/g, ""));
        for (let j = i + 1; j < lines.length && lines[j]!.startsWith(" "); j++) {
          const v = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(lines[j]!);
          if (v) {
            for (const k of keys) out.set(k, v[1]!);
            break;
          }
        }
      }
      return out;
    });
    return map.get(`${name}@${spec}`) ?? map.get(`${name}@npm:${spec}`);
  }
}

const SCOPES: [string, string][] = [
  ["dependencies", "runtime"],
  ["devDependencies", "dev"],
  ["peerDependencies", "peer"],
  ["optionalDependencies", "optional"],
];

export function parsePackageJson(content: string, rel: string, locks: NpmLocks): Dependency[] {
  let pkg: Obj;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isObj(parsed)) return [];
    pkg = parsed;
  } catch {
    return [];
  }
  const dir = dirOf(rel);
  const out: Dependency[] = [];
  for (const [field, scope] of SCOPES) {
    const group = pkg[field];
    if (!isObj(group)) continue;
    for (const [name, spec] of Object.entries(group)) {
      if (typeof spec !== "string") continue;
      const dep: Dependency = { ecosystem: "npm", name, versionSpec: spec, sourceFile: rel, scope, kind: "library" };
      const resolved = /^(workspace:|file:|link:|git|http)/.test(spec) ? undefined : locks.lookup(dir, name, spec);
      if (resolved) dep.resolvedVersion = resolved;
      out.push(dep);
    }
  }
  if (typeof pkg.packageManager === "string") {
    const m = /^([a-z]+)@([^+\s]+)/.exec(pkg.packageManager);
    if (m) out.push({ ecosystem: "tool", name: m[1]!, versionSpec: m[2]!, resolvedVersion: m[2]!, sourceFile: rel, scope: "packageManager", kind: "tool" });
  }
  const engines = pkg.engines;
  if (isObj(engines) && typeof engines.node === "string") {
    out.push({ ecosystem: "tool", name: "node", versionSpec: engines.node, sourceFile: rel, scope: "engines", kind: "tool" });
  }
  return out;
}
