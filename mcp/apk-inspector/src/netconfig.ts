import { decodeAxml, type XmlNode } from "./axml.js";
import type { Apk } from "./apk.js";
import { readManifest } from "./manifest.js";

export const NSC_PATH = "res/xml/network_security_config.xml";

interface TrustAnchor {
  src: string;
  overridePins?: boolean;
}

const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);

function anchors(node: XmlNode | undefined): TrustAnchor[] {
  if (!node) return [];
  return node.children
    .filter((c) => c.name === "certificates")
    .map((c) => {
      const a: TrustAnchor = { src: String(c.attrs["src"] ?? "") };
      const op = asBool(c.attrs["overridePins"]);
      if (op !== undefined) a.overridePins = op;
      return a;
    });
}

interface DomainConfig {
  domains: { domain: string; includeSubdomains: boolean }[];
  cleartextTrafficPermitted?: boolean;
  trustAnchors: TrustAnchor[];
  pinSets: { expiration?: string; pins: { digestAlgorithm: string; value: string }[] }[];
  debugOverrides?: { trustAnchors: TrustAnchor[] };
  nested: DomainConfig[];
}

function domainConfig(n: XmlNode, depth = 0): DomainConfig {
  const out: DomainConfig = {
    domains: n.children.filter((c) => c.name === "domain").map((d) => ({ domain: d.text ?? "", includeSubdomains: asBool(d.attrs["includeSubdomains"]) ?? false })),
    trustAnchors: anchors(n.children.find((c) => c.name === "trust-anchors")),
    pinSets: n.children
      .filter((c) => c.name === "pin-set")
      .map((p) => {
        const set: DomainConfig["pinSets"][number] = { pins: p.children.filter((x) => x.name === "pin").map((x) => ({ digestAlgorithm: String(x.attrs["digest"] ?? ""), value: x.text ?? "" })) };
        if (p.attrs["expiration"] !== undefined) set.expiration = String(p.attrs["expiration"]);
        return set;
      }),
    nested: depth < 8 ? n.children.filter((c) => c.name === "domain-config").map((c) => domainConfig(c, depth + 1)) : [],
  };
  const ct = asBool(n.attrs["cleartextTrafficPermitted"]);
  if (ct !== undefined) out.cleartextTrafficPermitted = ct;
  const dbg = n.children.find((c) => c.name === "debug-overrides");
  if (dbg) out.debugOverrides = { trustAnchors: anchors(dbg.children.find((c) => c.name === "trust-anchors") ?? dbg) };
  return out;
}

export function readNetworkConfig(apk: Apk): Record<string, unknown> {
  let manifest: ReturnType<typeof readManifest> | null = null;
  let manifestError: string | undefined;
  try {
    manifest = readManifest(apk);
  } catch (e) {
    manifestError = e instanceof Error ? e.message : String(e);
  }
  const result: Record<string, unknown> = {
    manifest: manifest
      ? { networkSecurityConfig: manifest.application.networkSecurityConfig, usesCleartextTraffic: manifest.application.usesCleartextTraffic, targetSdk: manifest.sdk.target }
      : { error: manifestError },
    configPath: NSC_PATH,
    present: apk.zip.byName.has(NSC_PATH),
    note: "The manifest only holds a resource reference (resources.arsc is not decoded), so the file is looked up at its conventional path. A renamed or obfuscated resource path will not be found.",
  };
  if (!apk.zip.byName.has(NSC_PATH)) {
    result["defaultsWithoutConfig"] = "With no network security config, cleartext HTTP is allowed when targetSdk < 28 and blocked from targetSdk 28 unless android:usesCleartextTraffic is true.";
    return result;
  }
  const root = decodeAxml(apk.readEntry(NSC_PATH));
  if (root.name !== "network-security-config") {
    result["error"] = `unexpected root element <${root.name}>`;
    return result;
  }
  const base = root.children.find((c) => c.name === "base-config");
  if (base) {
    const bc: Record<string, unknown> = { trustAnchors: anchors(base.children.find((c) => c.name === "trust-anchors")) };
    const ct = asBool(base.attrs["cleartextTrafficPermitted"]);
    if (ct !== undefined) bc["cleartextTrafficPermitted"] = ct;
    result["baseConfig"] = bc;
  }
  result["domainConfigs"] = root.children.filter((c) => c.name === "domain-config").slice(0, 500).map((c) => domainConfig(c));
  const dbg = root.children.find((c) => c.name === "debug-overrides");
  if (dbg) result["debugOverrides"] = { trustAnchors: anchors(dbg.children.find((c) => c.name === "trust-anchors")) };
  const findings: string[] = [];
  if (base && asBool(base.attrs["cleartextTrafficPermitted"]) === true) findings.push("base-config permits cleartext traffic for every domain.");
  const userTrust = (a: TrustAnchor[]): boolean => a.some((x) => x.src === "user");
  if (userTrust(anchors(base?.children.find((c) => c.name === "trust-anchors")))) findings.push("base-config trusts user-installed CA certificates.");
  if (dbg) findings.push("debug-overrides present: only honoured in debuggable builds.");
  result["auditFlags"] = findings;
  return result;
}
