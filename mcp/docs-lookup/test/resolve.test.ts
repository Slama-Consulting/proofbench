import { describe, expect, it } from "vitest";
import { Http } from "../src/http.js";
import { mavenCoordinates, resolvePackage } from "../src/resolve.js";
import { normalizeGithubUrl } from "../src/validate.js";
import { fakeFetch, type Route } from "./helpers/fake.js";

const http = (routes: Record<string, Route>) => {
  const f = fakeFetch(routes);
  return { f, h: new Http({ fetchFn: f.fn }) };
};

const meta = (versions: string[], latest = versions[versions.length - 1]!, release = true) =>
  `<?xml version="1.0"?><metadata><groupId>g</groupId><artifactId>a</artifactId><versioning>${release ? `<release>${latest}</release>` : `<latest>${latest}</latest>`}<versions>${versions.map((v) => `<version>${v}</version>`).join("")}</versions></versioning></metadata>`;

describe("normalizeGithubUrl", () => {
  it.each([
    ["git+https://github.com/colinhacks/zod.git", "https://github.com/colinhacks/zod"],
    ["https://github.com/a/b/tree/main/packages/x", "https://github.com/a/b"],
    ["git@github.com:a/b.git", "https://github.com/a/b"],
    ["scm:git:git://github.com/a/b.git", "https://github.com/a/b"],
    ["github:a/b", "https://github.com/a/b"],
    ["a/b", "https://github.com/a/b"],
    ["https://www.github.com/a/b#readme", "https://github.com/a/b"],
  ])("%s", (input, expected) => expect(normalizeGithubUrl(input)).toBe(expected));
  it("returns null for other hosts", () => {
    expect(normalizeGithubUrl("https://gitlab.com/a/b")).toBeNull();
    expect(normalizeGithubUrl("https://github.com.evil.com/a/b")).toBeNull();
    expect(normalizeGithubUrl(undefined)).toBeNull();
  });
});

describe("npm", () => {
  it("returns latest, version existence, repository, license", async () => {
    const { f, h } = http({
      "https://registry.npmjs.org/zod/latest": { version: "3.23.8", homepage: "https://zod.dev", repository: { type: "git", url: "git+https://github.com/colinhacks/zod.git" }, license: "MIT" },
      "https://registry.npmjs.org/zod/3.20.0": { version: "3.20.0", deprecated: "use a newer version", license: "MIT", repository: "github:colinhacks/zod" },
    });
    const a = await resolvePackage(h, { ecosystem: "npm", name: "zod" });
    expect(a).toMatchObject({ found: true, latestVersion: "3.23.8", repository: "https://github.com/colinhacks/zod", homepage: "https://zod.dev", documentationUrl: "https://zod.dev", license: "MIT", deprecated: false, registry: "registry.npmjs.org" });
    const b = await resolvePackage(h, { ecosystem: "npm", name: "zod", version: "3.20.0" });
    expect(b).toMatchObject({ versionExists: true, deprecated: true, deprecationMessage: "use a newer version" });
    const c = await resolvePackage(h, { ecosystem: "npm", name: "zod", version: "9.9.9" });
    expect(c).toMatchObject({ found: true, versionExists: false });
    expect(f.urls()).toContain("https://registry.npmjs.org/zod/9.9.9");
  });

  it("encodes scoped names, handles 404 and rejects bad names", async () => {
    const { f, h } = http({ "https://registry.npmjs.org/@types%2Fnode/latest": { version: "20.0.0" } });
    expect((await resolvePackage(h, { ecosystem: "npm", name: "@types/node" })).found).toBe(true);
    expect(f.urls()[0]).toBe("https://registry.npmjs.org/@types%2Fnode/latest");
    expect((await resolvePackage(h, { ecosystem: "npm", name: "does-not-exist" })).found).toBe(false);
    for (const bad of ["../etc", "a b", "UPPER", "a/b/c", "a?x=1", "a#b", "%2e%2e"]) {
      await expect(resolvePackage(h, { ecosystem: "npm", name: bad })).rejects.toThrow(/invalid/);
    }
    await expect(resolvePackage(h, { ecosystem: "npm", name: "zod", version: "1/../2" })).rejects.toThrow(/invalid version/);
  });

  it("turns registry failures into errors", async () => {
    const { h } = http({ "https://registry.npmjs.org/zod/latest": { status: 500 } });
    await expect(resolvePackage(h, { ecosystem: "npm", name: "zod" })).rejects.toThrow(/server error/);
  });
});

describe("PyPI", () => {
  it("resolves metadata and release existence", async () => {
    const { h } = http({
      "https://pypi.org/pypi/requests/json": {
        info: { version: "2.31.0", home_page: "", license: "Apache 2.0", project_urls: { Source: "https://github.com/psf/requests", Documentation: "https://requests.readthedocs.io" }, description: "# Requests\n\nHTTP for humans." },
        releases: { "2.31.0": [{}], "2.30.0": [{}] },
      },
    });
    const r = await resolvePackage(h, { ecosystem: "pypi", name: "requests", version: "2.30.0" });
    expect(r).toMatchObject({ found: true, latestVersion: "2.31.0", versionExists: true, repository: "https://github.com/psf/requests", documentationUrl: "https://requests.readthedocs.io", license: "Apache 2.0" });
    expect(r.readme).toContain("Requests");
    expect((await resolvePackage(h, { ecosystem: "pypi", name: "requests", version: "1.0" })).versionExists).toBe(false);
    expect((await resolvePackage(h, { ecosystem: "pypi", name: "nope" })).found).toBe(false);
  });
});

describe("crates.io", () => {
  it("resolves metadata and yanked versions", async () => {
    const { h } = http({
      "https://crates.io/api/v1/crates/serde": {
        crate: { max_stable_version: "1.0.195", max_version: "1.0.195", repository: "https://github.com/serde-rs/serde", documentation: "https://docs.rs/serde", homepage: "https://serde.rs" },
        versions: [{ num: "1.0.195", yanked: false, license: "MIT OR Apache-2.0" }, { num: "1.0.100", yanked: true, license: "MIT" }],
      },
    });
    const a = await resolvePackage(h, { ecosystem: "crates", name: "serde" });
    expect(a).toMatchObject({ found: true, latestVersion: "1.0.195", repository: "https://github.com/serde-rs/serde", documentationUrl: "https://docs.rs/serde", license: "MIT OR Apache-2.0" });
    const b = await resolvePackage(h, { ecosystem: "crates", name: "serde", version: "1.0.100" });
    expect(b).toMatchObject({ versionExists: true, deprecated: true });
    expect((await resolvePackage(h, { ecosystem: "crates", name: "serde", version: "0.0.1" })).versionExists).toBe(false);
  });
});

describe("Go", () => {
  it("resolves through the module proxy, escaping capitals, and reads Deprecated", async () => {
    const { f, h } = http({
      "https://proxy.golang.org/github.com/!burnt!sushi/toml/@latest": { Version: "v1.3.2" },
      "https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.2.0.info": { Version: "v1.2.0" },
      "https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.3.2.mod": "// Deprecated: use another module\nmodule github.com/BurntSushi/toml\n",
    });
    const r = await resolvePackage(h, { ecosystem: "go", name: "github.com/BurntSushi/toml", version: "v1.2.0" });
    expect(r).toMatchObject({ found: true, latestVersion: "v1.3.2", versionExists: true, repository: "https://github.com/BurntSushi/toml", documentationUrl: "https://pkg.go.dev/github.com/BurntSushi/toml" });
    expect(f.urls()).toContain("https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.2.0.info");
    expect((await resolvePackage(h, { ecosystem: "go", name: "github.com/BurntSushi/toml", version: "v1.3.2" })).deprecated).toBe(true);
    await expect(resolvePackage(h, { ecosystem: "go", name: "github.com/a/../b" })).rejects.toThrow(/invalid/);
  });
});

describe("Maven", () => {
  it("resolves from Maven Central with the POM scm", async () => {
    const { h } = http({
      "https://repo1.maven.org/maven2/com/squareup/okhttp3/okhttp/maven-metadata.xml": meta(["4.11.0", "4.12.0"]),
      "https://repo1.maven.org/maven2/com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.pom": `<project><name>OkHttp</name><url>https://square.github.io/okhttp/</url><licenses><license><name>Apache License, Version 2.0</name></license></licenses><scm><url>https://github.com/square/okhttp/</url></scm></project>`,
    });
    const r = await resolvePackage(h, { ecosystem: "maven", name: "com.squareup.okhttp3:okhttp", version: "4.12.0" });
    expect(r).toMatchObject({ found: true, latestVersion: "4.12.0", versionExists: true, repository: "https://github.com/square/okhttp", homepage: "https://square.github.io/okhttp/", documentationUrl: "https://square.github.io/okhttp/", license: "Apache License, Version 2.0", registry: "repo1.maven.org" });
  });

  it("falls back to Google Maven for AndroidX and follows the parent chain for the repository", async () => {
    const base = "https://dl.google.com/android/maven2/androidx/core/core-ktx";
    const { f, h } = http({
      [`${base}/maven-metadata.xml`]: meta(["1.12.0", "1.13.0"], "1.13.0", false),
      [`${base}/1.12.0/core-ktx-1.12.0.pom`]: `<project><parent><groupId>androidx.parent</groupId><artifactId>parent-a</artifactId><version>1</version></parent><name>core-ktx</name></project>`,
      "https://dl.google.com/android/maven2/androidx/parent/parent-a/1/parent-a-1.pom": `<project><parent><groupId>androidx.parent</groupId><artifactId>parent-b</artifactId><version>2</version></parent></project>`,
      "https://dl.google.com/android/maven2/androidx/parent/parent-b/2/parent-b-2.pom": `<project><scm><connection>scm:git:https://github.com/androidx/androidx.git</connection></scm><licenses><license><name>Apache-2.0</name></license></licenses></project>`,
    });
    const r = await resolvePackage(h, { ecosystem: "maven", name: "androidx.core:core-ktx", version: "1.12.0" });
    expect(r).toMatchObject({ found: true, latestVersion: "1.13.0", versionExists: true, repository: "https://github.com/androidx/androidx", license: "Apache-2.0", registry: "dl.google.com" });
    expect(f.urls()[0]).toBe("https://repo1.maven.org/maven2/androidx/core/core-ktx/maven-metadata.xml");
    expect(f.urls()[1]).toBe(`${base}/maven-metadata.xml`);
  });

  it("limits the parent chain to 3 levels above the artifact", async () => {
    const routes: Record<string, Route> = { "https://repo1.maven.org/maven2/g/a/maven-metadata.xml": meta(["1"]) };
    for (let i = 0; i < 6; i++) {
      const name = i === 0 ? "a" : `p${i}`;
      routes[`https://repo1.maven.org/maven2/g/${name}/1/${name}-1.pom`] = `<project><parent><groupId>g</groupId><artifactId>p${i + 1}</artifactId><version>1</version></parent></project>`;
    }
    const { f, h } = http(routes);
    const r = await resolvePackage(h, { ecosystem: "maven", name: "g:a" });
    expect(r.repository).toBeUndefined();
    expect(f.urls().filter((u) => u.endsWith(".pom"))).toHaveLength(4);
  });

  it("maps a Gradle plugin id to its marker artifact on the Plugin Portal and reads the implementation POM", async () => {
    const marker = "https://plugins.gradle.org/m2/com/diffplug/spotless/com.diffplug.spotless.gradle.plugin";
    const { f, h } = http({
      [`${marker}/maven-metadata.xml`]: meta(["6.24.0", "6.25.0"]),
      [`${marker}/6.25.0/com.diffplug.spotless.gradle.plugin-6.25.0.pom`]: `<project><dependencies><dependency><groupId>com.diffplug.spotless</groupId><artifactId>spotless-plugin-gradle</artifactId><version>6.25.0</version></dependency></dependencies></project>`,
      "https://plugins.gradle.org/m2/com/diffplug/spotless/spotless-plugin-gradle/6.25.0/spotless-plugin-gradle-6.25.0.pom": `<project><url>https://github.com/diffplug/spotless</url><scm><url>https://github.com/diffplug/spotless.git</url></scm></project>`,
    });
    const r = await resolvePackage(h, { ecosystem: "maven", name: "com.diffplug.spotless", version: "6.25.0" });
    expect(r).toMatchObject({ found: true, latestVersion: "6.25.0", versionExists: true, repository: "https://github.com/diffplug/spotless", registry: "plugins.gradle.org" });
    expect(f.urls()[0]).toBe(`${marker}/maven-metadata.xml`);
    expect(mavenCoordinates("com.diffplug.spotless")).toEqual({ group: "com.diffplug.spotless", artifact: "com.diffplug.spotless.gradle.plugin", marker: true });
    expect(mavenCoordinates("com.diffplug.spotless:com.diffplug.spotless.gradle.plugin").marker).toBe(true);
  });

  it("reports relocation as deprecation, unknown version, not found and bad names", async () => {
    const { h } = http({
      "https://repo1.maven.org/maven2/old/lib/maven-metadata.xml": meta(["1.0"]),
      "https://repo1.maven.org/maven2/old/lib/1.0/lib-1.0.pom": `<project><distributionManagement><relocation><groupId>new</groupId></relocation></distributionManagement></project>`,
    });
    const r = await resolvePackage(h, { ecosystem: "maven", name: "old:lib", version: "0.5" });
    expect(r).toMatchObject({ deprecated: true, deprecationMessage: "relocated to new:lib", versionExists: false });
    expect((await resolvePackage(h, { ecosystem: "maven", name: "no:such" })).found).toBe(false);
    await expect(resolvePackage(h, { ecosystem: "maven", name: "a:b:c" })).rejects.toThrow(/invalid/);
    await expect(resolvePackage(h, { ecosystem: "maven", name: "../x:y" })).rejects.toThrow(/invalid/);
  });
});

describe("tools", () => {
  it("resolves a built-in tool and its latest release; unknown tools are not found", async () => {
    const { h } = http({ "https://api.github.com/repos/gradle/gradle/releases/latest": { tag_name: "v8.14.0" } });
    const r = await resolvePackage(h, { ecosystem: "tool", name: "gradle" });
    expect(r).toMatchObject({ found: true, latestVersion: "8.14.0", versionExists: null, repository: "https://github.com/gradle/gradle", registry: "api.github.com" });
    const u = await resolvePackage(h, { ecosystem: "tool", name: "mystery" });
    expect(u.found).toBe(false);
    expect(u.notes.join(" ")).toMatch(/known tools/);
  });
});
