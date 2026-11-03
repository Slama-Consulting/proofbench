import { describe, expect, it } from "vitest";
import { fetchDocs } from "../src/docs.js";
import { Http } from "../src/http.js";
import { fakeFetch, tree, type Route } from "./helpers/fake.js";

const API = "https://api.github.com/repos/acme/widgets";
const RAW = "https://raw.githubusercontent.com/acme/widgets";

const README = `# Widgets\n\nA widget library.\n\n## Getting started\n\nInstall the package.\n`;
const GUIDE = `# Caching guide\n\n## Cache invalidation\n\nCall \`invalidateCache()\` to drop entries. The cache TTL defaults to 60 seconds.\n\n## Other\n\nUnrelated text.\n`;

function npmRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "https://registry.npmjs.org/widgets/latest": { version: "2.0.0", repository: { url: "git+https://github.com/acme/widgets.git" }, readme: "# widgets (npm)\n\nnpm readme text about registry.", license: "MIT" },
    "https://registry.npmjs.org/widgets/1.4.0": { version: "1.4.0", repository: { url: "git+https://github.com/acme/widgets.git" }, readme: "# widgets 1.4.0\n\nold readme", license: "MIT" },
    ...extra,
  };
}

const docsDirSha = "1".repeat(40);
const rootTree = tree([
  { path: "README.md" },
  { path: "docs", type: "tree", sha: docsDirSha },
  { path: "src", type: "tree", sha: "2".repeat(40) },
]);
const docsTree = tree([{ path: "caching.md" }, { path: "install.md" }, { path: "image.png" }, { path: "sub/deep.md" }]);

function repoRoutes(ref: string, refEnc = encodeURIComponent(ref)): Record<string, Route> {
  return {
    [`${API}/git/trees/${refEnc}`]: rootTree,
    [`${API}/git/trees/${docsDirSha}?recursive=1`]: docsTree,
    [`${RAW}/${ref}/README.md`]: README,
    [`${RAW}/${ref}/docs/caching.md`]: GUIDE,
    [`${RAW}/${ref}/docs/install.md`]: "# Install\n\nRun npm install.\n",
    [`${RAW}/${ref}/docs/sub/deep.md`]: "# Deep\n\ntext",
  };
}

const run = (routes: Record<string, Route>, input: Parameters<typeof fetchDocs>[1], opts: ConstructorParameters<typeof Http>[0] = {}) => {
  const f = fakeFetch(routes);
  return { f, p: fetchDocs(new Http({ fetchFn: f.fn, ...opts }), input) };
};

describe("fetchDocs: git ref matching", () => {
  it("uses the tag that matches the version (v{version}) and returns the best chunk first", async () => {
    const { f, p } = run({ ...npmRoutes(), ...repoRoutes("v1.4.0") }, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "cache invalidation" });
    const r = await p;
    expect(r.versionMatch).toBe("exact");
    expect(r.chunks[0]).toMatchObject({ heading: "Caching guide > Cache invalidation", ref: "v1.4.0", versionMatch: "exact", truncated: false, source: `${RAW}/v1.4.0/docs/caching.md` });
    expect(r.chunks[0]!.text).toContain("invalidateCache()");
    expect(f.urls()).toContain(`${API}/git/trees/v1.4.0`);
    expect(f.urls()).not.toContain(`${API}`);
    expect(r.truncated).toBe(false);
  });

  it("tries {version}, {name}-{version} and release/{version} in order", async () => {
    const { f, p } = run({ ...npmRoutes(), ...repoRoutes("widgets-1.4.0") }, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "cache" });
    const r = await p;
    expect(r.chunks[0]!.ref).toBe("widgets-1.4.0");
    const tried = f.urls().filter((u) => u.includes("/git/trees/") && !u.includes("recursive") && !/\/[0-9a-f]{40}$/.test(u));
    expect(tried).toEqual([`${API}/git/trees/v1.4.0`, `${API}/git/trees/1.4.0`, `${API}/git/trees/widgets-1.4.0`]);
  });

  it("encodes refs that contain a slash", async () => {
    const { p } = run({ ...npmRoutes(), ...repoRoutes("release/1.4.0", "release%2F1.4.0") }, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "cache" });
    expect((await p).chunks[0]!.ref).toBe("release/1.4.0");
  });

  it("falls back to the default branch and says so", async () => {
    const { p } = run({ ...npmRoutes(), [`${API}`]: { default_branch: "main" }, ...repoRoutes("main") }, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "cache invalidation" });
    const r = await p;
    expect(r.versionMatch).toBe("fallback_default_branch");
    expect(r.chunks.filter((c) => c.source.includes("/main/")).every((c) => c.versionMatch === "fallback_default_branch" && c.ref === "main")).toBe(true);
    expect(r.notes.join(" ")).toMatch(/no git ref matches version 1\.4\.0/);
  });

  it("uses the latest version when none is given and reports it", async () => {
    const { p } = run({ ...npmRoutes(), ...repoRoutes("v2.0.0") }, { ecosystem: "npm", name: "widgets", query: "cache invalidation" });
    const r = await p;
    expect(r.versionUsed).toBe("2.0.0");
    expect(r.chunks[0]!.versionMatch).toBe("exact");
  });

  it("warns when the requested version does not exist and serves the latest", async () => {
    const { p } = run({ ...npmRoutes(), ...repoRoutes("v2.0.0") }, { ecosystem: "npm", name: "widgets", version: "0.0.1", query: "cache invalidation" });
    const r = await p;
    expect(r.notes.join(" ")).toMatch(/does not exist in the registry/);
    expect(r.versionUsed).toBe("2.0.0");
  });

  it("falls back to raw README files when the GitHub API is rate limited", async () => {
    const routes: Record<string, Route> = {
      ...npmRoutes(),
      [`${API}/git/trees/v1.4.0`]: { status: 403, body: "rate limit" },
      [`${RAW}/v1.4.0/README.md`]: README,
    };
    const { p } = run(routes, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "getting started" });
    const r = await p;
    expect(r.notes.join(" ")).toMatch(/GitHub API unavailable/);
    expect(r.chunks[0]).toMatchObject({ heading: "Widgets > Getting started", ref: "v1.4.0", versionMatch: "exact" });
  });
});

describe("fetchDocs: sources and limits", () => {
  it("includes the registry README for npm and still works without a GitHub repository", async () => {
    const { p } = run({ "https://registry.npmjs.org/solo/latest": { version: "1.0.0", readme: "# solo\n\n## Usage\n\nCall solo().\n", homepage: "https://solo.example.com" } }, { ecosystem: "npm", name: "solo", query: "usage" });
    const r = await p;
    expect(r.chunks[0]).toMatchObject({ heading: "solo > Usage", versionMatch: "exact", source: "https://registry.npmjs.org/solo/1.0.0" });
    expect(r.notes.join(" ")).toMatch(/not fetched/);
  });

  it("converts the rendered crates.io README (documented redirect to static.crates.io)", async () => {
    const { p } = run(
      {
        "https://crates.io/api/v1/crates/tiny": { crate: { max_stable_version: "0.3.0" }, versions: [{ num: "0.3.0" }] },
        "https://crates.io/api/v1/crates/tiny/0.3.0/readme": { status: 302, headers: { location: "https://static.crates.io/readmes/tiny/tiny-0.3.0.html" } },
        "https://static.crates.io/readmes/tiny/tiny-0.3.0.html": "<h2>Features</h2><p>Zero-copy &amp; fast parser.</p>",
      },
      { ecosystem: "crates", name: "tiny", query: "features parser" },
    );
    const r = await p;
    expect(r.chunks[0]!.text).toContain("Zero-copy & fast parser.");
    expect(r.chunks[0]!.heading).toBe("Features");
  });

  it("never exceeds maxChars and flags truncation", async () => {
    const big = "# Big\n\n" + Array.from({ length: 40 }, (_v, i) => `## Cache topic ${i}\n\n${"cache details ".repeat(60)}`).join("\n\n");
    const routes = { ...npmRoutes(), ...repoRoutes("v1.4.0"), [`${RAW}/v1.4.0/docs/caching.md`]: big };
    for (const maxChars of [300, 1000, 6000]) {
      const { p } = run(routes, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "cache", maxChars });
      const r = await p;
      const total = r.chunks.reduce((n, c) => n + c.text.length, 0);
      expect(total).toBeLessThanOrEqual(maxChars);
      expect(r.totalChars).toBe(total);
      expect(r.truncated).toBe(true);
    }
    const { p } = run(routes, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "cache", maxChars: 99999 });
    expect((await p).maxChars).toBe(20000);
  });

  it("follows a README that is a git symlink to a package folder", async () => {
    const routes = { ...npmRoutes(), ...repoRoutes("v1.4.0"), [`${RAW}/v1.4.0/README.md`]: "packages/widgets/README.md\n", [`${RAW}/v1.4.0/packages/widgets/README.md`]: "# Real readme\n\n## Symlinked topic\n\nFound it.\n" };
    const { p } = run(routes, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "symlinked topic" });
    const r = await p;
    expect(r.chunks[0]).toMatchObject({ heading: "Real readme > Symlinked topic", source: `${RAW}/v1.4.0/packages/widgets/README.md` });
  });

  it("returns the start of the docs when nothing matches the query", async () => {
    const { p } = run({ ...npmRoutes(), ...repoRoutes("v1.4.0") }, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "zzzzqqqq" });
    const r = await p;
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.notes.join(" ")).toMatch(/no chunk matched/);
  });

  it("stays within the request budget", async () => {
    const files = Array.from({ length: 30 }, (_v, i) => ({ path: `guide${i}.md` }));
    const routes: Record<string, Route> = { ...npmRoutes(), ...repoRoutes("v1.4.0"), [`${API}/git/trees/${docsDirSha}?recursive=1`]: tree(files) };
    for (let i = 0; i < 30; i++) routes[`${RAW}/v1.4.0/docs/guide${i}.md`] = `# Guide ${i}\n\ncache`;
    const { f, p } = run(routes, { ecosystem: "npm", name: "widgets", version: "1.4.0", query: "guide cache" });
    await p;
    expect(f.calls.length).toBeLessThanOrEqual(30);
  });

  it("throws for unknown packages, empty queries and invalid versions", async () => {
    await expect(run({}, { ecosystem: "npm", name: "ghost", query: "x" }).p).rejects.toThrow(/not found/);
    await expect(run({}, { ecosystem: "npm", name: "ghost", query: "  " }).p).rejects.toThrow(/query/);
    await expect(run({}, { ecosystem: "npm", name: "ghost", version: "../1", query: "x" }).p).rejects.toThrow(/invalid version/);
    await expect(run({}, { ecosystem: "tool", name: "ghost", query: "x" }).p).rejects.toThrow(/unknown tool/);
  });
});

describe("fetchDocs: built-in overrides", () => {
  it("fetches the Spotless Gradle plugin README at the version's tag without asking a registry", async () => {
    const spot = "https://api.github.com/repos/diffplug/spotless";
    const raw = "https://raw.githubusercontent.com/diffplug/spotless";
    const { f, p } = run(
      {
        [`${spot}/git/trees/gradle%2F6.25.0`]: tree([{ path: "README.md" }, { path: "plugin-gradle", type: "tree" }]),
        [`${raw}/gradle/6.25.0/plugin-gradle/README.md`]: "# Spotless Gradle\n\n## Kotlin\n\nUse `ktlint()` inside the kotlin block.\n",
        [`${raw}/gradle/6.25.0/README.md`]: "# Spotless\n\nOverview.\n",
      },
      { ecosystem: "maven", name: "com.diffplug.spotless", version: "6.25.0", query: "kotlin ktlint" },
    );
    const r = await p;
    expect(r.versionMatch).toBe("exact");
    expect(r.chunks[0]).toMatchObject({ heading: "Spotless Gradle > Kotlin", ref: "gradle/6.25.0", source: `${raw}/gradle/6.25.0/plugin-gradle/README.md` });
    expect(f.urls().some((u) => u.includes("registry") || u.includes("plugins.gradle.org") || u.includes("repo1.maven.org"))).toBe(false);
    expect(r.notes.join(" ")).toMatch(/spotless-gradle/);
  });

  it("indexes the Gradle user guide directory (AsciiDoc) at v{version}", async () => {
    const g = "https://api.github.com/repos/gradle/gradle";
    const raw = "https://raw.githubusercontent.com/gradle/gradle";
    const dir = "platforms/documentation/docs/src/docs/userguide";
    const sha = (n: number) => String(n).repeat(40);
    const { p } = run(
      {
        [`${g}/git/trees/v8.5`]: { status: 404 },
        [`${g}/git/trees/v8.5.0`]: tree([{ path: "README.md" }, { path: "platforms", type: "tree", sha: sha(1) }]),
        [`${g}/git/trees/${sha(1)}`]: tree([{ path: "documentation", type: "tree", sha: sha(2) }]),
        [`${g}/git/trees/${sha(2)}`]: tree([{ path: "docs", type: "tree", sha: sha(3) }]),
        [`${g}/git/trees/${sha(3)}`]: tree([{ path: "src", type: "tree", sha: sha(4) }]),
        [`${g}/git/trees/${sha(4)}`]: tree([{ path: "docs", type: "tree", sha: sha(5) }]),
        [`${g}/git/trees/${sha(5)}`]: tree([{ path: "userguide", type: "tree", sha: sha(6) }]),
        [`${g}/git/trees/${sha(6)}?recursive=1`]: tree([{ path: "dependency-management/dependency_locking.adoc" }, { path: "running-builds/build_cache.adoc" }]),
        [`${raw}/v8.5.0/README.md`]: "# Gradle\n",
        [`${raw}/v8.5.0/${dir}/running-builds/build_cache.adoc`]: "= Build Cache\n\n== Enabling the build cache\n\nSet org.gradle.caching=true.\n",
        [`${raw}/v8.5.0/${dir}/dependency-management/dependency_locking.adoc`]: "= Locking\n\ntext\n",
      },
      { ecosystem: "tool", name: "gradle", version: "8.5", query: "build cache" },
    );
    const r = await p;
    expect(r.chunks[0]).toMatchObject({ heading: "Build Cache > Enabling the build cache", ref: "v8.5.0", versionMatch: "exact" });
    expect(r.chunks[0]!.text).toContain("org.gradle.caching=true");
  });
});
