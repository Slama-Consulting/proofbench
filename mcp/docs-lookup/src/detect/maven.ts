import { isExactVersion, type Dependency } from "./types.js";

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block);
  return m ? m[1] : undefined;
}

function blocks(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]!);
}

/** Parses a pom.xml with regular expressions (no XML parser, no external entity resolution). */
export function parsePom(content: string, rel: string): Dependency[] {
  let text = content.replace(/<!--[\s\S]*?-->/g, "");
  const props: Record<string, string> = {};
  const propsBlock = blocks(text, "properties")[0];
  if (propsBlock) {
    for (const m of propsBlock.matchAll(/<([A-Za-z][\w.-]*)>\s*([^<]*?)\s*<\/\1>/g)) props[m[1]!] = m[2]!;
  }
  const out: Dependency[] = [];

  const parentBlock = blocks(text, "parent")[0];
  if (parentBlock) {
    const v = tag(parentBlock, "version");
    if (v) props["parent.version"] = v;
    const g = tag(parentBlock, "groupId");
    if (g) props["parent.groupId"] = g;
    text = text.replace(/<parent>[\s\S]*?<\/parent>/, "");
  }
  const own = tag(text.replace(/<(dependencies|build|dependencyManagement|profiles|properties|reporting)>[\s\S]*?<\/\1>/g, ""), "version");
  if (own) {
    props["project.version"] = own;
    props.version = own;
  }

  const resolve = (raw: string | undefined): { spec: string; resolved?: string } => {
    if (!raw) return { spec: "" };
    let ok = true;
    const value = raw.replace(/\$\{([^}]+)\}/g, (_m, key: string) => {
      const v = props[key];
      if (v === undefined) ok = false;
      return v ?? "";
    });
    return { spec: raw, ...(ok && isExactVersion(value) ? { resolved: value } : {}) };
  };

  const add = (b: string, scope: string, kind: Dependency["kind"], defaultGroup?: string): void => {
    const g = tag(b, "groupId") ?? defaultGroup;
    const a = tag(b, "artifactId");
    if (!g || !a) return;
    const v = resolve(tag(b, "version"));
    out.push({
      ecosystem: "maven",
      name: `${g}:${a}`,
      versionSpec: v.spec,
      ...(v.resolved ? { resolvedVersion: v.resolved } : {}),
      sourceFile: rel,
      scope,
      kind,
    });
  };

  if (parentBlock) add(parentBlock, "parent", "library");

  const plugins = blocks(text, "plugin");
  text = text.replace(/<plugin>[\s\S]*?<\/plugin>/g, "");
  for (const p of plugins) {
    add(p.replace(/<(dependencies|executions|configuration|exclusions)>[\s\S]*?<\/\1>/g, ""), "build", "plugin", "org.apache.maven.plugins");
  }

  text = text.replace(/<exclusions>[\s\S]*?<\/exclusions>/g, "");
  const managed = blocks(text, "dependencyManagement")[0];
  if (managed) {
    for (const d of blocks(managed, "dependency")) add(d, `managed:${tag(d, "scope") ?? "compile"}`, "library");
    text = text.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, "");
  }
  for (const d of blocks(text, "dependency")) add(d, tag(d, "scope") ?? "compile", "library");
  return out;
}
