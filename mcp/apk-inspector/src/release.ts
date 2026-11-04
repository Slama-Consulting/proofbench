import type { Apk } from "./apk.js";
import type { ManifestInfo } from "./manifest.js";
import { readSignatures, signingSchemes } from "./signature.js";

const LARGE_ASSET_BYTES = 5 * 1024 * 1024;
const VERSION_HINT = /(snapshot|debug|test|mock|dirty|wip)/i;

export interface ReleaseReadiness {
  verdict: "looks-like-release" | "not-release-ready";
  /** Facts that normally do not belong in a build shipped to users. */
  blockers: string[];
  /** Things to look at; not wrong by themselves. */
  reviews: string[];
  note: string;
}

export interface ReleaseInput {
  manifest: ManifestInfo | undefined;
  manifestError: string | undefined;
  testClasses: number;
  jacocoClasses: number;
  debugToolingClasses: string[];
  obfuscationVerdict: string;
}

const NOTE = "Heuristic from static facts only: a release build can still ship debug code, and a debug-looking build can be intended. It is not a security verdict.";

export function releaseReadiness(apk: Apk, i: ReleaseInput): ReleaseReadiness {
  const blockers: string[] = [];
  const reviews: string[] = [];
  const m = i.manifest;

  if (m) {
    if (m.application.debuggable) blockers.push("android:debuggable is true: the app can be attached to and inspected on any device.");
    const testOnly = m.application.flags["testOnly"];
    if (testOnly === true || testOnly === "true") blockers.push("android:testOnly is true: this is a test build.");
    const testComponents = m.components.filter((c) => c.exported && c.name.startsWith("androidx.test.")).map((c) => c.name);
    if (testComponents.length) blockers.push(`${testComponents.length} androidx.test component(s) exported: ${testComponents.slice(0, 5).join(", ")}.`);
    if (m.application.usesCleartextTraffic === true) reviews.push("usesCleartextTraffic is true: plain HTTP is allowed.");
    const v = m.versionName === null ? "" : String(m.versionName);
    if (VERSION_HINT.test(v)) reviews.push(`versionName "${v.slice(0, 80)}" looks like a non-release build (snapshot, debug, test, mock, dirty or wip).`);
  } else {
    reviews.push(`The manifest could not be read${i.manifestError ? ` (${i.manifestError})` : ""}: debuggable, testOnly and exported test components were not checked.`);
  }

  if (i.testClasses > 0) blockers.push(`${i.testClasses} androidx.test class(es) are packaged: the test framework is in the APK.`);
  if (i.jacocoClasses > 0) blockers.push(`${i.jacocoClasses} org.jacoco class(es) are packaged: coverage instrumentation is in the APK.`);
  if (i.debugToolingClasses.length) reviews.push(`Debug tooling packaged: ${i.debugToolingClasses.join(", ")}.`);

  const schemes = signingSchemes(apk.zip);
  if (!schemes.v1 && !schemes.v2 && !schemes.v3 && !schemes.v31) {
    blockers.push("The APK is not signed (no v1, v2, v3 or v3.1 signature).");
  } else {
    try {
      const report = readSignatures(apk.zip);
      const certs = [report.v1, report.v2, report.v3, report.v31].flatMap((s) => s.signers.flatMap((x) => x.certificates));
      if (certs.some((c) => c.isDebugCertificate)) blockers.push("The APK is signed with the Android debug certificate.");
      const expired = certs.find((c) => c.expired);
      if (expired) blockers.push(`The signing certificate expired on ${expired.validTo.slice(0, 10)}.`);
    } catch {
      reviews.push("The signing certificates could not be parsed.");
    }
  }

  const large = apk.zip.entries.filter((e) => !e.name.endsWith("/") && !/^(classes\d*\.dex|resources\.arsc)$/.test(e.name) && e.uncompressedSize >= LARGE_ASSET_BYTES).sort((a, b) => b.uncompressedSize - a.uncompressedSize);
  for (const e of large.slice(0, 5)) reviews.push(`${e.name} is ${(e.uncompressedSize / 1024 / 1024).toFixed(1)} MB: confirm it is meant to ship.`);

  if (i.obfuscationVerdict === "unlikely") reviews.push("No obfuscation or shrinking detected: class names are readable.");

  return { verdict: blockers.length ? "not-release-ready" : "looks-like-release", blockers, reviews, note: NOTE };
}
