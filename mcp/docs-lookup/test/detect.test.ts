import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCatalog, parseGradleBuild, parseGradleWrapper, finishGradle } from "../src/detect/gradle.js";
import { parsePom } from "../src/detect/maven.js";
import { parseCargoToml, parseGoMod } from "../src/detect/native.js";
import { NpmLocks, parsePackageJson } from "../src/detect/npm.js";
import { parsePyproject, parseRequirementsTxt } from "../src/detect/python.js";
import { detectProject, MAX_DEPENDENCIES, MAX_MANIFESTS } from "../src/detect/scan.js";
import { parseToml } from "../src/detect/toml.js";
import type { Dependency, FileAccess } from "../src/detect/types.js";
import { tmpDir } from "./helpers/fake.js";

function files(map: Record<string, string>): FileAccess {
  return { has: (r) => r in map, read: (r) => map[r] };
}

function put(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const find = (deps: Dependency[], name: string, scope?: string): Dependency | undefined => deps.find((d) => d.name === name && (!scope || d.scope === scope));

describe("mini TOML", () => {
  it("parses sections, dotted keys, inline tables and multi-line arrays", () => {
    const doc = parseToml(`
[versions]
kotlin = "1.9.22"
[libraries]
core = { module = "androidx.core:core-ktx", version.ref = "kotlin" }
[project]
dependencies = [
  "requests>=2",  # comment
  "click",
]
[target.'cfg(unix)'.dependencies]
libc = "0.2"
`);
    expect(doc.versions!.kotlin).toBe("1.9.22");
    expect(doc.libraries!.core).toEqual({ module: "androidx.core:core-ktx", version: { ref: "kotlin" } });
    expect(doc.project!.dependencies).toEqual(["requests>=2", "click"]);
    expect(doc["target.cfg(unix).dependencies"]!.libc).toBe("0.2");
  });
});

describe("npm", () => {
  const pkg = JSON.stringify({
    dependencies: { zod: "^3.23.0", local: "workspace:*" },
    devDependencies: { typescript: "~5.4.0" },
    packageManager: "pnpm@9.1.0",
    engines: { node: ">=20" },
  });

  it("resolves exact versions from package-lock.json (v3)", () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/zod": { version: "3.23.8" }, "node_modules/typescript": { version: "5.4.5" } } });
    const deps = parsePackageJson(pkg, "package.json", new NpmLocks(files({ "package.json": pkg, "package-lock.json": lock })));
    expect(find(deps, "zod")).toMatchObject({ ecosystem: "npm", versionSpec: "^3.23.0", resolvedVersion: "3.23.8", scope: "runtime", kind: "library" });
    expect(find(deps, "typescript")).toMatchObject({ resolvedVersion: "5.4.5", scope: "dev" });
    expect(find(deps, "local")!.resolvedVersion).toBeUndefined();
    expect(find(deps, "pnpm")).toMatchObject({ ecosystem: "tool", kind: "tool", resolvedVersion: "9.1.0" });
    expect(find(deps, "node")).toMatchObject({ ecosystem: "tool", versionSpec: ">=20" });
  });

  it("reads pnpm-lock.yaml (v9 importers) and yarn.lock (classic and berry)", () => {
    const pnpm = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      zod:\n        specifier: ^3.23.0\n        version: 3.23.8\n    devDependencies:\n      typescript:\n        specifier: ~5.4.0\n        version: 5.4.5(foo@1.0.0)\npackages:\n  zod@3.23.8:\n    resolution: {integrity: sha512-x}\n`;
    const a = parsePackageJson(pkg, "package.json", new NpmLocks(files({ "package.json": pkg, "pnpm-lock.yaml": pnpm })));
    expect(find(a, "zod")!.resolvedVersion).toBe("3.23.8");
    expect(find(a, "typescript")!.resolvedVersion).toBe("5.4.5");
    const yarn1 = `# yarn lockfile v1\n\nzod@^3.23.0:\n  version "3.23.8"\n  resolved "https://x"\n\n"typescript@~5.4.0":\n  version "5.4.5"\n`;
    const b = parsePackageJson(pkg, "package.json", new NpmLocks(files({ "package.json": pkg, "yarn.lock": yarn1 })));
    expect(find(b, "zod")!.resolvedVersion).toBe("3.23.8");
    expect(find(b, "typescript")!.resolvedVersion).toBe("5.4.5");
    const berry = `__metadata:\n  version: 6\n\n"zod@npm:^3.23.0":\n  version: 3.23.8\n  resolution: "zod@npm:3.23.8"\n`;
    const c = parsePackageJson(pkg, "package.json", new NpmLocks(files({ "package.json": pkg, "yarn.lock": berry })));
    expect(find(c, "zod")!.resolvedVersion).toBe("3.23.8");
  });

  it("finds a root lock file from a workspace package", () => {
    const lock = JSON.stringify({ packages: { "node_modules/zod": { version: "3.1.0" }, "apps/web/node_modules/zod": { version: "3.2.0" } } });
    const deps = parsePackageJson(JSON.stringify({ dependencies: { zod: "^3" } }), "apps/web/package.json", new NpmLocks(files({ "package-lock.json": lock })));
    expect(deps[0]!.resolvedVersion).toBe("3.2.0");
    expect(parsePackageJson("{ not json", "package.json", new NpmLocks(files({})))).toEqual([]);
  });
});

describe("Gradle", () => {
  const empty = files({});

  it("parses Groovy DSL: string notation, map notation, plugins, variables", () => {
    const groovy = `
buildscript {
  ext.kotlin_version = '1.9.22'
  dependencies { classpath "com.android.tools.build:gradle:8.2.0" }
}
plugins {
  id 'com.diffplug.spotless' version '6.25.0'
  id "org.jetbrains.kotlin.android" version "$kotlin_version" apply false
}
apply plugin: 'com.android.application'
dependencies {
  implementation 'androidx.core:core-ktx:1.12.0'
  api("com.squareup.okhttp3:okhttp:4.12.0")
  testImplementation group: 'junit', name: 'junit', version: '4.13.2'
  implementation "org.jetbrains.kotlin:kotlin-stdlib:$kotlin_version"
  implementation platform('com.google.firebase:firebase-bom:32.7.0')
  // implementation 'commented:out:1.0'
}`;
    const deps = finishGradle(parseGradleBuild(groovy, "app/build.gradle", empty, undefined));
    expect(find(deps, "androidx.core:core-ktx")).toMatchObject({ ecosystem: "maven", versionSpec: "1.12.0", resolvedVersion: "1.12.0", scope: "implementation", kind: "library" });
    expect(find(deps, "com.squareup.okhttp3:okhttp")!.scope).toBe("api");
    expect(find(deps, "junit:junit")).toMatchObject({ resolvedVersion: "4.13.2", scope: "testImplementation" });
    expect(find(deps, "org.jetbrains.kotlin:kotlin-stdlib")).toMatchObject({ versionSpec: "$kotlin_version", resolvedVersion: "1.9.22" });
    expect(find(deps, "com.google.firebase:firebase-bom")!.resolvedVersion).toBe("32.7.0");
    expect(find(deps, "com.android.tools.build:gradle")).toMatchObject({ kind: "plugin", scope: "classpath", resolvedVersion: "8.2.0" });
    expect(find(deps, "com.diffplug.spotless")).toMatchObject({ kind: "plugin", resolvedVersion: "6.25.0" });
    expect(find(deps, "org.jetbrains.kotlin.android")).toMatchObject({ kind: "plugin", resolvedVersion: "1.9.22" });
    expect(find(deps, "com.android.application")).toMatchObject({ kind: "plugin", resolvedVersion: "8.2.0" });
    expect(find(deps, "kotlin", undefined)).toMatchObject({ ecosystem: "tool", resolvedVersion: "1.9.22" });
    expect(deps.some((d) => d.name.startsWith("commented"))).toBe(false);
  });

  it("parses Kotlin DSL: parentheses, map notation, kotlin(\"jvm\"), val variables", () => {
    const kts = `
val ktorVersion = "2.3.7"
plugins {
    kotlin("jvm") version "1.9.21"
    id("com.diffplug.spotless") version "6.23.3"
}
dependencies {
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    implementation("io.ktor:ktor-server-netty:\${ktorVersion}")
    runtimeOnly(group = "ch.qos.logback", name = "logback-classic", version = "1.4.14")
    testImplementation(kotlin("test"))
}`;
    const deps = parseGradleBuild(kts, "build.gradle.kts", empty, undefined);
    expect(find(deps, "org.jetbrains.kotlin.jvm")).toMatchObject({ kind: "plugin", resolvedVersion: "1.9.21" });
    expect(find(deps, "com.diffplug.spotless")!.versionSpec).toBe("6.23.3");
    expect(find(deps, "io.ktor:ktor-server-core")!.resolvedVersion).toBe("2.3.7");
    expect(find(deps, "io.ktor:ktor-server-netty")!.resolvedVersion).toBe("2.3.7");
    expect(find(deps, "ch.qos.logback:logback-classic")).toMatchObject({ resolvedVersion: "1.4.14", scope: "runtimeOnly" });
  });

  it("parses a version catalog with version.ref and resolves alias(libs.plugins.x)", () => {
    const toml = `
[versions]
agp = "8.2.0"
kotlin = "1.9.22"
compose-bom = "2024.02.00"
[libraries]
androidx-core-ktx = { module = "androidx.core:core-ktx", version = "1.12.0" }
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
okhttp = "com.squareup.okhttp3:okhttp:4.12.0"
no-version = { module = "androidx.compose.ui:ui" }
[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
`;
    const cat = parseCatalog(toml);
    expect(cat.libraries.get("compose-bom")).toMatchObject({ group: "androidx.compose", name: "compose-bom", versionSpec: "ref:compose-bom", resolved: "2024.02.00" });
    expect(cat.libraries.get("no-version")!.versionSpec).toBe("");
    const build = `plugins { alias(libs.plugins.android.application)\n alias(libs.plugins.kotlin.android) }`;
    const deps = parseGradleBuild(build, "app/build.gradle.kts", empty, cat);
    expect(find(deps, "com.android.application")).toMatchObject({ resolvedVersion: "8.2.0", versionSpec: "ref:agp" });
    expect(find(deps, "org.jetbrains.kotlin.android")!.resolvedVersion).toBe("1.9.22");
  });

  it("reads the Gradle wrapper as a tool", () => {
    const props = "distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip\n";
    expect(parseGradleWrapper(props, "gradle/wrapper/gradle-wrapper.properties")).toEqual([
      { ecosystem: "tool", name: "gradle", versionSpec: "8.5", resolvedVersion: "8.5", sourceFile: "gradle/wrapper/gradle-wrapper.properties", scope: "wrapper", kind: "tool" },
    ]);
  });
});

describe("Maven pom.xml", () => {
  it("resolves property-based versions and separates plugins, managed and plugin-internal dependencies", () => {
    const pom = `<?xml version="1.0"?>
<project>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.1</version></parent>
  <version>1.0.0</version>
  <properties><junit.version>5.10.1</junit.version><jackson.version>2.16.0</jackson.version></properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-bom</artifactId><version>\${jackson.version}</version><scope>import</scope></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>\${junit.version}</version><scope>test</scope></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId>
      <exclusions><exclusion><groupId>x</groupId><artifactId>y</artifactId></exclusion></exclusions></dependency>
    <!-- <dependency><groupId>no</groupId><artifactId>no</artifactId></dependency> -->
  </dependencies>
  <build><plugins>
    <plugin><artifactId>maven-compiler-plugin</artifactId><version>3.12.1</version>
      <dependencies><dependency><groupId>inside</groupId><artifactId>plugin</artifactId><version>1</version></dependency></dependencies></plugin>
  </plugins></build>
</project>`;
    const deps = parsePom(pom, "pom.xml");
    expect(find(deps, "org.junit.jupiter:junit-jupiter")).toMatchObject({ versionSpec: "${junit.version}", resolvedVersion: "5.10.1", scope: "test" });
    expect(find(deps, "com.fasterxml.jackson:jackson-bom")).toMatchObject({ scope: "managed:import", resolvedVersion: "2.16.0" });
    expect(find(deps, "org.springframework.boot:spring-boot-starter-web")).toMatchObject({ versionSpec: "", scope: "compile" });
    expect(find(deps, "org.apache.maven.plugins:maven-compiler-plugin")).toMatchObject({ kind: "plugin", resolvedVersion: "3.12.1" });
    expect(find(deps, "org.springframework.boot:spring-boot-starter-parent")).toMatchObject({ scope: "parent", resolvedVersion: "3.2.1" });
    expect(deps.some((d) => d.name === "inside:plugin" || d.name === "x:y" || d.name === "no:no")).toBe(false);
  });
});

describe("Python", () => {
  it("parses requirements files", () => {
    const deps = parseRequirementsTxt(
      `# comment\nrequests==2.31.0\nFlask_SQLAlchemy>=3.0,<4 ; python_version > "3.8"\n-r other.txt\n-e .\ngit+https://github.com/x/y.git\nnumpy[extra]~=1.26 # inline\nrich\n`,
      "requirements.txt",
    );
    expect(deps.map((d) => d.name)).toEqual(["requests", "flask-sqlalchemy", "numpy", "rich"]);
    expect(find(deps, "requests")).toMatchObject({ ecosystem: "pypi", versionSpec: "==2.31.0", resolvedVersion: "2.31.0" });
    expect(find(deps, "flask-sqlalchemy")!.versionSpec).toBe(">=3.0,<4");
    expect(find(deps, "numpy")!.resolvedVersion).toBeUndefined();
  });

  it("parses pyproject.toml (PEP 621 and Poetry)", () => {
    const deps = parsePyproject(
      `[project]\nname="x"\nrequires-python = ">=3.10"\ndependencies = ["httpx>=0.27", "pydantic==2.6.1"]\n[project.optional-dependencies]\ndev = ["pytest>=8"]\n[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = { version = "^0.110.0", extras = ["all"] }\n[tool.poetry.group.test.dependencies]\ncoverage = "^7.0"\n[build-system]\nrequires = ["hatchling"]\n`,
      "pyproject.toml",
    );
    expect(find(deps, "httpx")!.scope).toBe("runtime");
    expect(find(deps, "pydantic")!.resolvedVersion).toBe("2.6.1");
    expect(find(deps, "pytest")!.scope).toBe("optional:dev");
    expect(find(deps, "fastapi")).toMatchObject({ versionSpec: "^0.110.0" });
    expect(find(deps, "coverage")!.scope).toBe("group:test");
    expect(find(deps, "hatchling")!.scope).toBe("build");
    expect(deps.filter((d) => d.name === "python").map((d) => d.ecosystem)).toEqual(["tool", "tool"]);
  });
});

describe("Go and Rust", () => {
  it("parses go.mod", () => {
    const deps = parseGoMod(`module example.com/app\n\ngo 1.22\ntoolchain go1.22.3\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/sys v0.15.0 // indirect\n)\nrequire github.com/stretchr/testify v1.8.4\nreplace x => ../x\n`, "go.mod");
    expect(find(deps, "github.com/gin-gonic/gin")).toMatchObject({ ecosystem: "go", resolvedVersion: "v1.9.1", scope: "runtime" });
    expect(find(deps, "golang.org/x/sys")!.scope).toBe("indirect");
    expect(find(deps, "github.com/stretchr/testify")!.versionSpec).toBe("v1.8.4");
    expect(deps.filter((d) => d.name === "go").map((d) => d.versionSpec)).toEqual(["1.22", "1.22.3"]);
  });

  it("parses Cargo.toml and resolves versions from Cargo.lock", () => {
    const toml = `[package]\nname = "app"\nrust-version = "1.75"\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\ntokio = "1"\nlocal = { path = "../local" }\nfromgit = { git = "https://github.com/x/y" }\n[dev-dependencies]\ncriterion = "0.5"\n[dependencies.clap]\nversion = "4.4"\n[target.'cfg(unix)'.dependencies]\nlibc = "0.2"\n`;
    const lock = `version = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.195"\n\n[[package]]\nname = "tokio"\nversion = "1.35.1"\n\n[[package]]\nname = "clap"\nversion = "4.4.18"\n`;
    const deps = parseCargoToml(toml, "Cargo.toml", files({ "Cargo.lock": lock }));
    expect(find(deps, "serde")).toMatchObject({ ecosystem: "crates", versionSpec: "1.0", resolvedVersion: "1.0.195", scope: "runtime" });
    expect(find(deps, "tokio")!.resolvedVersion).toBe("1.35.1");
    expect(find(deps, "clap")).toMatchObject({ versionSpec: "4.4", resolvedVersion: "4.4.18" });
    expect(find(deps, "criterion")!.scope).toBe("dev");
    expect(find(deps, "libc")).toBeDefined();
    expect(find(deps, "local")).toBeUndefined();
    expect(find(deps, "fromgit")!.versionSpec).toBe("git");
    expect(find(deps, "rust")).toMatchObject({ ecosystem: "tool", versionSpec: "1.75" });
  });
});

describe("detectProject", () => {
  it("scans a mixed repository, skips ignored folders and reports languages and build systems", () => {
    const root = tmpDir();
    put(root, "package.json", JSON.stringify({ dependencies: { zod: "^3.23.0" } }));
    put(root, "package-lock.json", JSON.stringify({ packages: { "node_modules/zod": { version: "3.23.8" } } }));
    put(root, "src/index.ts", "export {}");
    put(root, "src/a.ts", "export {}");
    put(root, "android/build.gradle.kts", `plugins { id("com.diffplug.spotless") version "6.25.0" }`);
    put(root, "android/gradle/libs.versions.toml", `[libraries]\nokhttp = "com.squareup.okhttp3:okhttp:4.12.0"\n`);
    put(root, "android/gradle/wrapper/gradle-wrapper.properties", "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-all.zip");
    put(root, "android/app/Main.kt", "fun main() {}");
    put(root, "node_modules/evil/package.json", JSON.stringify({ dependencies: { evil: "1" } }));
    put(root, "build/package.json", JSON.stringify({ dependencies: { evil2: "1" } }));
    put(root, ".git/package.json", JSON.stringify({ dependencies: { evil3: "1" } }));
    put(root, "service/go.mod", "module x\ngo 1.22\n");
    put(root, "py/requirements.txt", "requests==2.31.0\n");
    put(root, "rs/Cargo.toml", `[dependencies]\nserde = "1"\n`);
    put(root, "java/pom.xml", `<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1</version></dependency></dependencies></project>`);

    const r = detectProject(root);
    expect(r.dependencies.map((d) => d.name)).not.toContain("evil");
    expect(r.dependencies.map((d) => d.name)).not.toContain("evil2");
    expect(r.dependencies.map((d) => d.name)).not.toContain("evil3");
    expect(find(r.dependencies, "zod")).toMatchObject({ resolvedVersion: "3.23.8", sourceFile: "package.json" });
    expect(find(r.dependencies, "com.diffplug.spotless")).toMatchObject({ kind: "plugin", sourceFile: "android/build.gradle.kts" });
    expect(find(r.dependencies, "com.squareup.okhttp3:okhttp")).toMatchObject({ scope: "catalog", sourceFile: "android/gradle/libs.versions.toml" });
    expect(find(r.dependencies, "gradle")).toMatchObject({ ecosystem: "tool", resolvedVersion: "8.5" });
    expect(find(r.dependencies, "requests")).toBeDefined();
    expect(find(r.dependencies, "serde")).toBeDefined();
    expect(find(r.dependencies, "g:a")).toBeDefined();
    expect(r.languages[0]).toEqual({ language: "TypeScript", files: 2 });
    expect(r.languages.some((l) => l.language === "Kotlin")).toBe(true);
    expect(r.buildSystems).toEqual(expect.arrayContaining(["npm", "gradle", "maven", "pip", "go", "cargo"]));
    expect(r.manifests).toContain("android/build.gradle.kts");
    expect(r.manifests.some((m) => m.includes("node_modules"))).toBe(false);
  });

  it("never follows symlinks out of the repository", () => {
    const outside = tmpDir("docs-lookup-outside-");
    put(outside, "package.json", JSON.stringify({ dependencies: { secret: "1" } }));
    const root = tmpDir();
    put(root, "package.json", JSON.stringify({ dependencies: { zod: "1" } }));
    try {
      symlinkSync(outside, join(root, "linked-dir"), "junction");
      symlinkSync(join(outside, "package.json"), join(root, "sub-package.json"), "file");
      mkdirSync(join(root, "real"), { recursive: true });
      symlinkSync(join(outside, "package.json"), join(root, "real", "package.json"), "file");
    } catch {
      // creating symlinks needs privileges on some systems: the structural checks below still hold
    }
    const r = detectProject(root);
    expect(r.dependencies.map((d) => d.name)).not.toContain("secret");
    expect(r.manifests).toEqual(["package.json"]);
  });

  it("caps manifests and dependencies and says so", () => {
    const root = tmpDir();
    for (let i = 0; i < MAX_MANIFESTS + 20; i++) put(root, `pkg${String(i).padStart(3, "0")}/package.json`, JSON.stringify({ dependencies: { [`dep-${i}`]: "1.0.0" } }));
    const r = detectProject(root);
    expect(r.manifests).toHaveLength(MAX_MANIFESTS);
    expect(r.limits.manifestsTruncated).toBe(true);

    const root2 = tmpDir();
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_DEPENDENCIES + 50; i++) many[`dep-${i}`] = "1.0.0";
    put(root2, "package.json", JSON.stringify({ dependencies: many }));
    const r2 = detectProject(root2);
    expect(r2.dependencies).toHaveLength(MAX_DEPENDENCIES);
    expect(r2.limits.dependenciesTruncated).toBe(true);
  });

  it("refuses a path that is not a directory and survives a malformed manifest", () => {
    expect(() => detectProject(join(tmpDir(), "missing"))).toThrow(/not an accessible directory/);
    const root = tmpDir();
    put(root, "package.json", "{ broken");
    put(root, "go.mod", "module x\nrequire github.com/a/b v1.0.0\n");
    const r = detectProject(root);
    expect(r.dependencies.map((d) => d.name)).toContain("github.com/a/b");
  });
});
