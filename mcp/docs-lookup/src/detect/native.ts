/** Go (go.mod) and Rust (Cargo.toml / Cargo.lock) manifests. */
import { asString, asTable, parseToml, type TomlTable, type TomlValue } from "./toml.js";
import { dirOf, join, isExactVersion, type Dependency, type FileAccess } from "./types.js";

export function parseGoMod(content: string, rel: string): Dependency[] {
  const out: Dependency[] = [];
  let inRequire = false;
  for (const raw of content.replace(/\r\n?/g, "\n").split("\n")) {
    const indirect = /\/\/\s*indirect/.test(raw);
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const goV = /^go\s+([0-9][0-9.]*)$/.exec(line);
    if (goV) {
      out.push({ ecosystem: "tool", name: "go", versionSpec: goV[1]!, resolvedVersion: goV[1]!, sourceFile: rel, scope: "go-directive", kind: "tool" });
      continue;
    }
    const tc = /^toolchain\s+go([0-9][0-9A-Za-z.+-]*)$/.exec(line);
    if (tc) {
      out.push({ ecosystem: "tool", name: "go", versionSpec: tc[1]!, resolvedVersion: tc[1]!, sourceFile: rel, scope: "toolchain", kind: "tool" });
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ")") {
      inRequire = false;
      continue;
    }
    const m = inRequire ? /^(\S+)\s+(v\S+)$/.exec(line) : /^require\s+(\S+)\s+(v\S+)$/.exec(line);
    if (m) {
      out.push({ ecosystem: "go", name: m[1]!, versionSpec: m[2]!, resolvedVersion: m[2]!, sourceFile: rel, scope: indirect ? "indirect" : "runtime", kind: "library" });
    }
  }
  return out;
}

/** name -> versions[] from a Cargo.lock. */
function cargoLockVersions(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const block of text.replace(/\r\n?/g, "\n").split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) map.set(name, [...(map.get(name) ?? []), version]);
  }
  return map;
}

function cargoDeps(table: TomlTable | undefined, rel: string, scope: string, lock: Map<string, string[]> | undefined): Dependency[] {
  const out: Dependency[] = [];
  for (const [key, v] of Object.entries(table ?? {})) {
    let spec: string | undefined;
    let name = key;
    if (typeof v === "string") spec = v;
    else {
      const t = asTable(v as TomlValue);
      if (!t) continue;
      spec = asString(t.version) ?? (t.git !== undefined ? "git" : t.path !== undefined || t.workspace !== undefined ? undefined : "");
      name = asString(t.package) ?? key;
    }
    if (spec === undefined) continue;
    const dep: Dependency = { ecosystem: "crates", name, versionSpec: spec, sourceFile: rel, scope, kind: "library" };
    const versions = lock?.get(name);
    if (versions && new Set(versions).size === 1) dep.resolvedVersion = versions[0]!;
    else if (isExactVersion(spec) && /^=/.test(spec)) dep.resolvedVersion = spec.slice(1);
    out.push(dep);
  }
  return out;
}

export function parseCargoToml(content: string, rel: string, files: FileAccess): Dependency[] {
  const doc = parseToml(content);
  let lock: Map<string, string[]> | undefined;
  for (let dir = dirOf(rel); ; dir = dirOf(dir)) {
    const f = join(dir, "Cargo.lock");
    if (files.has(f)) {
      lock = cargoLockVersions(files.read(f) ?? "");
      break;
    }
    if (!dir) break;
  }
  const out: Dependency[] = [];
  const sections: [RegExp, string][] = [
    [/^(?:workspace\.)?dependencies$/, "runtime"],
    [/^(?:workspace\.)?dev-dependencies$/, "dev"],
    [/^(?:workspace\.)?build-dependencies$/, "build"],
    [/^target\..+\.dependencies$/, "runtime"],
    [/^target\..+\.dev-dependencies$/, "dev"],
    [/^target\..+\.build-dependencies$/, "build"],
  ];
  for (const [section, table] of Object.entries(doc)) {
    for (const [re, scope] of sections) {
      if (re.test(section)) out.push(...cargoDeps(table, rel, scope, lock));
    }
    // [dependencies.serde] version = "1"
    const sub = /^(dependencies|dev-dependencies|build-dependencies)\.([^.]+)$/.exec(section);
    if (sub) {
      out.push(...cargoDeps({ [sub[2]!]: table }, rel, sub[1] === "dependencies" ? "runtime" : sub[1] === "dev-dependencies" ? "dev" : "build", lock));
    }
  }
  const rv = asString(doc.package?.["rust-version"]);
  if (rv) out.push({ ecosystem: "tool", name: "rust", versionSpec: rv, sourceFile: rel, scope: "rust-version", kind: "tool" });
  return out;
}
