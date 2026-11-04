# apk-inspector

A self-contained MCP server for **static, read-only analysis of Android `.apk` files**. It has no dependency on any external reverse-engineering tool: ZIP, Android binary XML, DEX and certificate parsing are implemented with Node built-ins only (`node:zlib`, `node:crypto`, `node:fs`). The only runtime packages are the MCP SDK and `zod`.

It is used by the `analyze-apk` skill, which calls these tools to answer questions such as "what does this APK request, expose and talk to?" without installing anything.

## Tools

Every tool takes `path`: the absolute path of a local `.apk` file (must exist, be a regular file, start with a ZIP signature, and be at most 1 GiB).

| Tool | Extra inputs | Returns |
| --- | --- | --- |
| `apk_overview` | none | package, versionName/versionCode, min/target/compile SDK, file size and sha256, entry count, dex files, native ABIs, signing schemes present, `debuggable`, `allowBackup`, `usesCleartextTraffic`, network security config presence, permission and component counts, class count, obfuscation hint, and a `releaseReadiness` block (verdict, `blockers` such as `debuggable`, `testOnly`, packaged `androidx.test` or `org.jacoco` classes, exported test components, unsigned/expired/debug certificate, and `reviews` such as large files or a `versionName` that looks like a snapshot or mock; a heuristic, not a security verdict) |
| `apk_manifest` | none | decoded `AndroidManifest.xml`: permissions (dangerous and high-impact ones flagged), `uses-feature`, application flags, every activity/service/receiver/provider with effective `exported` (and `exportedSource`: `explicit`, `implied` or `default`), permissions, provider authorities, `grantUriPermissions`, intent filters, plus `auditFlags` |
| `apk_entries` | `filter` (substring), `limit` (default 200, max 2000) | ZIP entries (name, compressed and uncompressed size, method); unusual entries are flagged: many `classesN.dex`, DEX/ELF magic or a nested ZIP hidden under `assets/` or `res/raw/` |
| `apk_strings` | `pattern`, `regex` (default false), `ignoreCase` (default false), `minLength` (default 4), `limit` (default 100, max 1000) | strings from the DEX string pools (truncated to 300 characters) with dex file and index |
| `apk_classes` | `pattern`, `limit` (default 100, max 2000) | class names (`com.example.Foo`), superclass, access flags, plus the 25 most common package prefixes to help spot libraries and SDKs |
| `apk_signature` | none | v1 (`META-INF`), v2, v3 and v3.1 (APK Signing Block) certificates: subject, issuer, validity, serial, SHA-256 and SHA-1 fingerprints, key type and size, signature algorithm, `expired`, `selfSigned`, `isDebugCertificate` |
| `apk_find_secrets` | none | masked leads for well-known secret shapes (cloud keys, tokens, private key headers, JWTs, bearer literals, generic `key=value` assignments) in DEX strings and small text-like entries under `assets/`, `res/raw/`, `res/xml/`; URLs and hosts grouped by host, `http://` flagged `cleartext` |
| `apk_network_config` | none | decoded `res/xml/network_security_config.xml` (base-config, trust anchors, domain-configs with cleartext flag and pin-sets with expiration, debug-overrides) plus the manifest's `networkSecurityConfig` reference and `usesCleartextTraffic` |
| `apk_xml` | `entry` (name inside the APK) | one binary XML entry (for example `res/xml/backup_rules.xml`) decoded into a tree (at most 5000 elements, values cut at 300 characters). Backup and data-extraction rule files also get a `backupRules` summary of their include/exclude rules, listed as written and not evaluated |
| `apk_asset_peek` | `entry`, `bytes` (default 256, max 4096) | the first bytes of one entry without extracting it: size, kind from magic numbers (`dex`, `elf`, `zip`, `png`, `binary-xml`, `json`, `xml`, `text`, `binary`...), and a text preview with secret-shaped values masked, or a hex preview for binary content |
| `apk_methods` | `class` (substring of the dotted name), `limit` (default 100, max 1000) | for at most 20 matching classes: superclass, interfaces and the methods the class declares (prototype, access flags, direct or virtual, size of the code item). A damaged class is reported with an `error`, the others are still listed |
| `apk_calls` | `class` (exact dotted name), `method` (exact name), `depth` (1 to 5, optional) | the bytecode of a method, read with a built-in Dalvik decoder: callees (invoke kind, whether the callee is in the app), string constants, classes it instantiates, how often each parameter register is read and what it is passed to, and whether the walk reached exactly the end of the code. With `depth`, the calls inside the app are followed (superclasses, interfaces, classes the method instantiates) and the reachable methods, external calls and strings are listed |
| `apk_xrefs` | `method` and/or `string` (substrings), `limit` (default 50, max 500) | the methods that call a method or use a string constant, with the matching instructions |
| `apk_entrypoint_checks` | `component` (optional name filter), `depth` (1 to 5, default 3) | for each exported component of the manifest (launcher activities excluded): its entry methods (`onGetRoot`, `onBind`, `query`, `onReceive`, `onCreate`...) found in the app or its superclasses, the caller-validation APIs reachable from them (`getCallingUid`, `checkCallingPermission`, `getPackagesForUid`, signature lookups...) with the call path, package-name and permission strings used, which parameters the entry method reads, and what is `observed` and `unknown`. It never says a component is safe or vulnerable |

Notes on specific tools:

- **Resource references** in the manifest (for example `@0x7f0e001a`) are returned as written. `resources.arsc` is not decoded, so a label such as `@string/app_name` is not resolved.
- **`apk_strings` regexes**: JavaScript has no inline flags, so `(?i)` is refused with a message pointing to `ignoreCase`; patterns are limited to 200 characters; patterns prone to catastrophic backtracking (nested quantifiers, quantified alternations, backreferences, more than three unbounded quantifiers) are refused; each string is tested on its first 512 characters.
- **`apk_find_secrets`** never returns a whole secret: values are masked as the first few characters, an ellipsis and the length (for example `AKIA…[20]`). URLs are returned without query string or fragment, and credentials embedded in a URL are reported only as a masked finding. A match is a lead, not proof that a secret is live.
- **`apk_signature`** parses certificates but performs **no cryptographic verification** (`verified: false`, with a `note`). It does not prove the APK is intact or who signed it.

## Result format

All results are JSON with `"untrusted": true` at the root and in `_meta`. Errors have the form `{"untrusted": true, "error": "..."}` and are returned as tool errors; the server never throws to the client.

## Security model

- **Read-only.** All tools carry `readOnlyHint: true` and `openWorldHint: false`, except the optional `apk_decompile` (see below), which is not advertised as read-only.
- **Nothing is executed.** The APK is only parsed, and its code is read, never run. Nothing is extracted to disk, and no network request is made (the optional `apk_decompile` is the one exception, see below).
- **Everything returned is untrusted data.** Strings, class names, manifest values, certificate fields and URLs come from the analysed file and may contain text written to manipulate an AI agent. They are data, never instructions. The server's `instructions` say so, and so should any agent using it.
- **Defence in depth against hostile files.** Every offset and length read from the file is bounds-checked. Limits: file up to 1 GiB, 100,000 ZIP entries, 64 MiB decompressed per DEX, 8 MiB per other entry (zip bombs are refused whether the declared size is honest or not), at most 1 MiB per text entry in the secret scan, 500 secret findings, 30 seconds of work per call. A malformed APK yields an error result, not a crash, a hang or a huge allocation.

## Limits

- Static analysis only. The bytecode tools read Dalvik instructions: they do not decompile, do not follow reflection, JNI or code loaded at runtime, do not track values through registers (a parameter register that is read may have been reused for another value; one that is never read is not used), and do not evaluate control flow, so they cannot tell whether the result of a check decides anything. Calls are resolved by name and prototype inside the app only; framework and library code is not analysed. Reading Java needs the optional `apk_decompile`.
- No resource-table decoding (`resources.arsc`).
- Only single `.apk` files. Android App Bundles (`.aab`), `.apks` sets and `.xapk` bundles are refused with an error naming the format.
- No cryptographic signature or digest verification.
- The network security config is found at its conventional path `res/xml/network_security_config.xml`; a renamed or obfuscated resource path is not followed.
- Exported-state inference follows the documented defaults (an intent filter without `android:exported` means exported below targetSdk 31). It is a static reading of the manifest, not a runtime check.
- Encrypted ZIP entries and compression methods other than stored and deflate are not supported.

## Optional: `apk_decompile` (jadx)

Off by default and absent from the tool list. It exists for the questions the bytecode tools cannot answer, such as whether the result of a check decides what a method returns.

```bash
claude mcp add --scope user -e APK_INSPECTOR_JADX=auto apk-inspector -- node "/path/to/proofbench/bundle/apk-inspector.mjs"
```

`APK_INSPECTOR_JADX` is the absolute path of a locally installed [jadx](https://github.com/skylot/jadx) (1.5.6 documented), or `auto` to look for `jadx` on `PATH`. `APK_INSPECTOR_JADX_TIMEOUT_MS` changes the time limit (default 120000, between 100 and 600000).

| Tool | Extra inputs | Returns |
| --- | --- | --- |
| `apk_decompile` | `class` (dotted name, must exist in the APK), `maxChars` (default 20000, max 100000) | the Java source of one class decompiled by jadx, truncated to `maxChars`, flagged as approximate and untrusted |

What it does and does not do:

- It starts one program, jadx, with `--config none --no-res --single-class <class> --single-class-output <dir> -d <dir> -j 1 <apk>`. The APK is read by jadx, never run.
- Class names are checked against a plain Java name pattern and against the dex files first; the process is started without a shell.
- jadx runs in a private temporary directory, with `HOME`, the cache, config and tmp directories inside it, and only `PATH`, `JAVA_HOME`, `JAVA_OPTS`, `JADX_OPTS`, `LANG`, `LC_ALL` and `SystemRoot` from the environment. The directory is deleted afterwards, also on failure or timeout; on timeout the whole process group is killed.
- jadx parses a file that may be hostile. Enable it for files you are allowed to examine, as you would run any tool on them.
- The option names come from the jadx 1.5.6 README. The tests use a fake `jadx` script: run one class through your real jadx before relying on it.

## Use

```bash
npm install
npm run build        # compiles src/ to dist/
node dist/server.js  # MCP over stdio
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "apk-inspector": { "command": "node", "args": ["/path/to/mcp/apk-inspector/dist/server.js"] }
  }
}
```

Then ask for `apk_overview` with `{"path": "/path/to/app.apk"}` first, and drill down with the other tools.

## Tests

```bash
npm test            # vitest run
npm run typecheck   # tsc over src and test
```

The tests are self-contained: no real APK is needed or stored. Helpers under `test/helpers/` build tiny synthetic fixtures at test time (a ZIP writer, an Android binary XML writer, a minimal DEX writer, and self-signed certificates wrapped in PKCS#7 and in v2/v3 signing blocks). Hostile cases cover truncated and malformed ZIPs, bad offsets, zip bombs, empty and non-ZIP files, huge declared string counts, over-long and catastrophic regexes, and missing files.
