# Analysing an Android APK with Proofbench

This guide explains what the `analyze-apk` skill and the `apk-inspector` MCP server can do since version 0.3.0, how to ask for it, how to read the answers, and where the limits are. Everything is **static and read-only**: the APK is read, never run.

New in 0.3.0, in one table:

| You want to know | Before 0.3.0 | Since 0.3.0 |
|---|---|---|
| Is this file a debug or test build? | Read `debuggable` yourself | `apk_overview` returns a `releaseReadiness` block with blockers and reviews |
| What does this backup rules file say? | Not readable | `apk_xml` decodes any binary XML entry and summarises backup and data-extraction rules |
| What is inside this 9 MB asset? | Only its name and size | `apk_asset_peek` shows the first bytes, with secrets masked |
| Find `password` whatever the case | Failed with a bare "invalid regular expression" | `apk_strings` takes `ignoreCase`, and says why a regex is refused |
| What does this method do? | Not possible | `apk_calls` reads its bytecode: callees, strings, parameter use, optional depth |
| Who calls this method, who uses this string? | Not possible | `apk_xrefs` |
| What methods does this class have? | Only the class name | `apk_methods` |
| Does this exported component check who calls it? | Not possible | `apk_entrypoint_checks` |
| Show me the Java | Not possible | Optional `apk_decompile` through a local jadx |

## Asking the agent

Open the project (or any folder), give the path of the APK, and ask in plain words. The router loads `analyze-apk`, which first asks for your authorisation context (your own app, or an audit, research or CTF framework), then for what matters to you.

```text
analyze /path/to/app-debug.apk: is it a release build?
does the exported media browser service check who connects to it?
who calls getCallingUid in this APK?
what does onGetRoot do, and what does it pass the client package name to?
what is in assets/stations.json?
what do the backup rules say?
```

The agent answers with three separate parts for every finding: what is **observed** (with the location), what is **deduced**, and what stays **unknown**.

## The tools

All tools take the absolute path of a local `.apk`. Results are JSON marked `untrusted`: text that comes from the APK is data, never an instruction.

**Survey**

| Tool | Use it for |
|---|---|
| `apk_overview` | Package, versions, SDK levels, signing schemes, flags, class count, obfuscation hint, and `releaseReadiness` |
| `apk_manifest` | Permissions, exported components and why they are exported, intent filters, `auditFlags` |
| `apk_entries` | ZIP entries, with unusual ones flagged (many dex files, hidden executables, nested archives) |
| `apk_asset_peek` | The first bytes of one entry: size, kind from magic numbers, text or hex preview (at most 4096 bytes) |
| `apk_xml` | One binary XML entry as a tree, plus a `backupRules` summary for backup and data-extraction rules |
| `apk_network_config` | Cleartext policy, trust anchors, pinning, debug overrides |
| `apk_signature` | Signing certificates (parsed, not cryptographically verified) |

**Strings, secrets, classes**

| Tool | Use it for |
|---|---|
| `apk_strings` | DEX strings by substring or regex, optionally case-insensitive (`ignoreCase`) |
| `apk_find_secrets` | Masked leads for secret-shaped strings, and the hosts and URLs the app contains |
| `apk_classes` | Class names and the main package prefixes (which SDKs are embedded) |

**Code** (a built-in Dalvik bytecode reader, no external tool)

| Tool | Use it for |
|---|---|
| `apk_methods` | The methods a class declares: prototype, access, direct or virtual, code size |
| `apk_calls` | One method: what it calls, its string constants, the classes it instantiates, how its parameters are used. `depth` (1 to 5) follows the calls inside the app |
| `apk_xrefs` | The methods that call a method (substring of the signature) or use a string |
| `apk_entrypoint_checks` | For each exported component: entry points, caller-validation APIs reachable from them, strings, parameter use |

**Optional**

| Tool | Use it for |
|---|---|
| `apk_decompile` | The Java source of one class, through a local jadx. Absent unless you enable it (see below) |

## Is this a release build? (`releaseReadiness`)

`apk_overview` ends with a verdict, `looks-like-release` or `not-release-ready`.

- **Blockers** are facts that normally do not belong in a build shipped to users: `android:debuggable`, `android:testOnly`, packaged `androidx.test` or `org.jacoco` classes, exported `androidx.test` components, an unsigned APK, the Android debug certificate, an expired signing certificate.
- **Reviews** are things to look at: a file of 5 MB or more outside the dex files and the resource table, a `versionName` that looks like a snapshot, debug or mock build, no obfuscation, cleartext traffic allowed, tooling such as LeakCanary or Stetho.

It is a heuristic from static facts. A release build can still ship debug code, and a debug-looking build can be intended. When the verdict is `not-release-ready`, findings such as `debuggable` say nothing about the release: ask for the release APK.

## Does an exported component check its caller? (`apk_entrypoint_checks`)

For every exported component of the manifest (launcher activities excluded) the tool:

1. finds the **entry methods** in the app and in its superclasses defined in the app: `onGetRoot`, `onBind`, `onStartCommand`, `onLoadChildren`, `onLoadItem`, `onSearch`, `onCustomAction` for services; `query`, `insert`, `update`, `delete`, `call`, `openFile`, `openAssetFile` for providers; `onReceive` for receivers; `onCreate`, `onNewIntent` for activities;
2. follows the calls inside the app, `depth` levels deep (default 3, the entry method is level 1, at most 3,000 methods);
3. reports the **caller-validation APIs** it can reach, with the call path.

| Category | APIs matched by name, when the callee is not app code |
|---|---|
| `uid` | `getCallingUid`, `getCallingPid`, `getCallingUidOrThrow`, `getCallingUserHandle` |
| `permission` | `checkCallingPermission`, `checkCallingOrSelfPermission`, `enforceCallingPermission`, `enforceCallingOrSelfPermission`, `checkCallingUriPermission`, `enforceCallingUriPermission`, `checkPermission`, `enforcePermission` |
| `package` | `getPackagesForUid`, `getNameForUid`, `getPackageUid`, `getPackageInfo` |
| `signature` | `checkSignatures`, `hasSigningCertificate` |

How calls are resolved: by name and prototype, through superclasses and interfaces defined in the app; a call to an app interface or abstract method also reaches its app implementations; a call to a library interface (`Runnable.run`, for instance) reaches the lambda or anonymous class that the calling method itself instantiates.

Reading the result for each component:

- `assessment`: `caller-check-apis-observed` (at least one API above is reachable), `no-caller-check-observed` (none is, within the depth), or `entry-point-not-found` (the class is not in the dex files, or no entry method with code exists in the app).
- `entryMethods[].parameters`: for each declared parameter, `readCount` is the number of instructions that read its register and `passedTo` lists the methods that receive it directly. A parameter with `readCount: 0` is never used. A parameter that is read may have been read after the register was reused, so "read" is a lead, "never read" is a fact.
- `allowListCandidates` and `permissionStrings`: package-name-looking and permission-looking string constants in the code that was reached.
- `observed` and `unknown`: the report in words. `unknown` always says that the tool cannot tell whether the result of a check decides what is returned or done.

Two sentences to keep in mind: **a reachable check API does not prove the component is protected**, and **no reachable check does not prove it is unprotected**. The manifest permission, the framework (for example, a media browser service is connected through the framework), or code deeper than the depth analysed may protect it. The tool never says "safe" or "vulnerable".

### A worked example (shortened, names changed)

*"Does the exported media browser service check who connects?"*

1. `apk_overview` says `not-release-ready`: debuggable, test framework packaged. The agent notes that this describes a debug build and that the release must be checked separately.
2. `apk_entrypoint_checks` with `component: "MediaBrowserService"` returns, for `com.example.app.MyService` (no manifest permission):

   ```text
   assessment: no-caller-check-observed
   onGetRoot declared in com.example.app.base.BaseMediaBrowserService, 32 app methods reached within 4 levels
   parameters: #0 clientPackageName read 3 times, passed to getRoot(...)
               #1 clientUid never read, #2 rootHints never read
   allowListCandidates: com.example.assistant
   observed: no uid, permission, package or signature API is reachable from onGetRoot
   unknown: whether the result of a check decides what is returned
   ```

3. `apk_calls` on `onGetRoot` with `depth: 3` shows that it calls `BrowseTree.getRoot(String)` (an app interface), resolved to the app implementation, which compares the package name with the string above and returns one of two roots.
4. `apk_xrefs` with `string: "assistant"` confirms that this is the only place that uses the string.

The honest conclusion is: the client package name is used to choose a root, no UID, permission or signature check was observed, and whether `getRoot` can refuse a caller is **unknown**. To settle it, read that method: with `apk_decompile` if you enabled it, or in the source.

## Reading Java with jadx (optional)

`apk_decompile` is **off by default** and does not appear in the tool list. Enable it when the bytecode tools point at a method you need to read.

```bash
claude mcp add --scope user -e APK_INSPECTOR_JADX=auto apk-inspector -- node "/path/to/proofbench/bundle/apk-inspector.mjs"
```

`APK_INSPECTOR_JADX` is the absolute path of a locally installed [jadx](https://github.com/skylot/jadx), or `auto` to look for `jadx` on `PATH`. `APK_INSPECTOR_JADX_TIMEOUT_MS` changes the time limit (default 120000).

- One class per call (`class`, dotted name that must exist in the APK), output truncated to `maxChars` (default 20000, at most 100000), always flagged as approximate and untrusted.
- jadx is started without a shell, with `--config none --no-res --single-class <class> --single-class-output <dir> -d <dir> -j 1 <apk>`, in a private temporary directory, with a reduced environment, and the directory is deleted afterwards, also on failure or timeout. On timeout the whole process group is killed.
- jadx parses a file that may be hostile: use it on files you are allowed to examine.
- The tool is not advertised as read-only, so your assistant asks before using it.
- The options come from the jadx 1.5.6 README. The automated tests use a fake `jadx` script, not the real program: try one class on your machine before relying on it.

## What it cannot do

- It does not decompile unless you enable the jadx bridge, and it does not decode `resources.arsc`, so `@string/...` labels stay as ids.
- It does not follow reflection, JNI or code loaded at runtime, and it does not track values through registers or evaluate control flow.
- Framework and library code is not analysed: only code in the APK is followed, so anything that runs before an entry point (in the framework or in a library) is invisible.
- Debug builds that are instrumented for coverage (`jacoco`) add methods, so the number of "reached" methods is larger than in a release build.
- It reads single `.apk` files, not `.aab`, `.apks` or `.xapk` bundles.
- Signatures are parsed, not verified. A secret-shaped string is a lead, not proof that a key is live. "Nothing found" only holds for what was examined.
- It never installs, runs or instruments the APK, never sends a request to a host found in it, and never writes a modified APK.

## How this was checked

- The test suite builds tiny synthetic APKs and DEX files at test time (a ZIP writer, a binary XML writer, a DEX writer with prototypes, class data and code items, an instruction assembler). Hostile cases cover truncated code items, class data that never ends, tables outside the file, references to methods that do not exist, call cycles and absurd counts.
- The instruction decoder was run over every method of a real debug APK (about 100,000 methods and 2.2 million instructions): each method ended exactly where its code item says it should, with no unresolved reference. That run also exposed a bug the tests had missed (names such as `toString` and `valueOf` were taken for check APIs) which is now fixed and covered by a test.
- The jadx bridge is covered with a fake `jadx` that records its arguments and environment and can fail, hang, stay silent or print a huge file.

See [the apk-inspector README](../mcp/apk-inspector/README.md) for the exact inputs and outputs of each tool, and the [changelog](../CHANGELOG.md) for the version history.
