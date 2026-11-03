import { describe, expect, it } from "vitest";
import { chunkText, MAX_CHUNK_CHARS, rank, tokenize } from "../src/chunk.js";
import { OVERRIDES, findOverride, overrideProblems } from "../src/overrides.js";
import data from "../src/data/overrides.json" with { type: "json" };

const DOC = `# Project

Intro text about the project.

## Installation

Install with npm. Run the installer.

\`\`\`bash
# this comment is not a heading
npm install thing
\`\`\`

## Configuration

### Retry policy

Set \`maxRetries\` to control how often a failed request is retried.

### Timeouts

Use requestTimeout to limit waiting time.

## License

MIT
`;

describe("chunkText", () => {
  it("splits on headings, keeps the heading path and ignores # inside code fences", () => {
    const chunks = chunkText(DOC);
    expect(chunks.map((c) => c.heading)).toEqual(["Project", "Project > Installation", "Project > Configuration > Retry policy", "Project > Configuration > Timeouts", "Project > License"]);
    const install = chunks.find((c) => c.heading.endsWith("Installation"))!;
    expect(install.text).toContain("# this comment is not a heading");
    expect(install.text).toContain("npm install thing");
  });

  it("splits long sections into pieces of at most ~1500 characters without cutting small paragraphs", () => {
    const para = "word ".repeat(60).trim() + ".";
    const long = "# Big\n\n" + Array.from({ length: 20 }, () => para).join("\n\n");
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.map((c) => c.text).join(" ").split("word").length - 1).toBe(20 * 60);
  });

  it("hard-splits a single enormous line", () => {
    const chunks = chunkText("# X\n" + "a".repeat(4000));
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("understands AsciiDoc headings", () => {
    const chunks = chunkText("= Guide\n\nHello\n\n== Plugins\n\nUse plugins.\n\n----\n== not a heading\n----\n", { adoc: true });
    expect(chunks.map((c) => c.heading)).toEqual(["Guide", "Guide > Plugins"]);
    expect(chunks[1]!.text).toContain("== not a heading");
  });

  it("returns nothing for empty text", () => {
    expect(chunkText("   \n\n")).toEqual([]);
  });
});

describe("tokenize", () => {
  it("lowercases, drops stop words, and splits identifiers while keeping the whole", () => {
    const t = tokenize("How to configure maxRetries and request_timeout?");
    expect(t).toContain("configure");
    expect(t).toContain("maxretry");
    expect(t).toContain("max");
    expect(t).toContain("retry");
    expect(t).toContain("timeout");
    expect(t).not.toContain("how");
    expect(t).not.toContain("to");
    expect(t).not.toContain("and");
  });
});

describe("rank", () => {
  const chunks = chunkText(DOC);

  it("returns the chunk whose heading matches the query first", () => {
    expect(rank(chunks, "retry policy")[0]!.chunk.heading).toBe("Project > Configuration > Retry policy");
    expect(rank(chunks, "installation")[0]!.chunk.heading).toBe("Project > Installation");
    expect(rank(chunks, "license")[0]!.chunk.heading).toBe("Project > License");
  });

  it("matches code identifiers in the body", () => {
    expect(rank(chunks, "maxRetries")[0]!.chunk.heading).toContain("Retry policy");
    expect(rank(chunks, "requestTimeout limit")[0]!.chunk.heading).toContain("Timeouts");
  });

  it("scores chunks with no query term at 0 and keeps document order for ties", () => {
    const r = rank(chunks, "zzzunknownzzz");
    expect(r.every((x) => x.score === 0)).toBe(true);
    expect(r.map((x) => x.chunk.order)).toEqual([...r.map((x) => x.chunk.order)].sort((a, b) => a - b));
  });

  it("weights headings above body text", () => {
    const two = chunkText("# A\n\n## Gradle\n\nSomething else entirely.\n\n## Other\n\nThe gradle word appears once here in the body text.");
    expect(rank(two, "gradle")[0]!.chunk.heading).toBe("A > Gradle");
  });
});

describe("overrides map", () => {
  it("is structurally valid JSON data", () => {
    expect(overrideProblems()).toEqual([]);
    expect(Array.isArray((data as { entries: unknown[] }).entries)).toBe(true);
    expect(OVERRIDES.length).toBeGreaterThanOrEqual(3);
  });

  it("maps Spotless to the plugin-gradle README and the repository README", () => {
    const e = findOverride("maven", "com.diffplug.spotless")!;
    expect(e.id).toBe("spotless-gradle");
    expect(e.sources[0]!.repository).toBe("https://github.com/diffplug/spotless");
    expect(e.sources[0]!.files).toEqual(["plugin-gradle/README.md", "README.md"]);
    expect(findOverride("maven", "com.diffplug.spotless:com.diffplug.spotless.gradle.plugin")?.id).toBe("spotless-gradle");
    expect(findOverride("maven", "COM.DIFFPLUG.SPOTLESS")?.id).toBe("spotless-gradle");
  });

  it("maps Gradle to the user guide directory and Kotlin to its repositories", () => {
    const g = findOverride("tool", "gradle")!;
    expect(g.sources[0]!.repository).toBe("https://github.com/gradle/gradle");
    expect(g.sources[0]!.dirs).toEqual(["platforms/documentation/docs/src/docs/userguide"]);
    expect(g.sources[0]!.refTemplates[0]).toBe("v{version}");
    const k = findOverride("maven", "org.jetbrains.kotlin.android")!;
    expect(k.id).toBe("kotlin");
    expect(findOverride("tool", "kotlin")?.sources.map((s) => s.repository)).toContain("https://github.com/JetBrains/kotlin");
  });

  it("does not match other ecosystems or unknown names", () => {
    expect(findOverride("npm", "gradle")).toBeUndefined();
    expect(findOverride("maven", "com.example:lib")).toBeUndefined();
    expect(findOverride("tool", "nope")).toBeUndefined();
  });

  it("reports structural problems", () => {
    const bad = [{ id: "x", title: "", match: { ecosystems: ["tool"], names: [], namePrefixes: [] }, repository: "https://example.com/a/b", homepage: "", documentationUrl: "", sources: [] }];
    expect(overrideProblems(bad).length).toBeGreaterThanOrEqual(3);
  });
});
