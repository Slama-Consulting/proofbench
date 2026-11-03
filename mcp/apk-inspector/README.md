# apk-inspector

A self-contained MCP server for **static, read-only analysis of Android `.apk` files**. It has no dependency on any external reverse-engineering tool: ZIP, Android binary XML, DEX and certificate parsing are implemented with Node built-ins only (`node:zlib`, `node:crypto`, `node:fs`). The only runtime packages are the MCP SDK and `zod`.

It is used by the `analyze-apk` skill, which calls these tools to answer questions such as "what does this APK request, expose and talk to?" without installing anything.

## Tools

Every tool takes `path`: the absolute path of a local `.apk` file (must exist, be a regular file, start with a ZIP signature, and be at most 1 GiB).

| Tool | Extra inputs | Returns |
| --- | --- | --- |
| `apk_overview` | none | package, versionName/versionCode, min/target/compile SDK, file size and sha256, entry count, dex files, native ABIs, signing schemes present, `debuggable`, `allowBackup`, `usesCleartextTraffic`, network security config presence, permission and component counts, class count, obfuscation hint |
| `apk_manifest` | none | decoded `AndroidManifest.xml`: permissions (dangerous and high-impact ones flagged), `uses-feature`, application flags, every activity/service/receiver/provider with effective `exported` (and `exportedSource`: `explicit`, `implied` or `default`), permissions, provider authorities, `grantUriPermissions`, intent filters, plus `auditFlags` |
| `apk_entries` | `filter` (substring), `limit` (default 200, max 2000) | ZIP entries (name, compressed and uncompressed size, method); unusual entries are flagged: many `classesN.dex`, DEX/ELF magic or a nested ZIP hidden under `assets/` or `res/raw/` |
| `apk_strings` | `pattern`, `regex` (default false), `minLength` (default 4), `limit` (default 100, max 1000) | strings from the DEX string pools (truncated to 300 characters) with dex file and index |
| `apk_classes` | `pattern`, `limit` (default 100, max 2000) | class names (`com.example.Foo`), superclass, access flags, plus the 25 most common package prefixes to help spot libraries and SDKs |
| `apk_signature` | none | v1 (`META-INF`), v2, v3 and v3.1 (APK Signing Block) certificates: subject, issuer, validity, serial, SHA-256 and SHA-1 fingerprints, key type and size, signature algorithm, `expired`, `selfSigned`, `isDebugCertificate` |
| `apk_find_secrets` | none | masked leads for well-known secret shapes (cloud keys, tokens, private key headers, JWTs, bearer literals, generic `key=value` assignments) in DEX strings and small text-like entries under `assets/`, `res/raw/`, `res/xml/`; URLs and hosts grouped by host, `http://` flagged `cleartext` |
| `apk_network_config` | none | decoded `res/xml/network_security_config.xml` (base-config, trust anchors, domain-configs with cleartext flag and pin-sets with expiration, debug-overrides) plus the manifest's `networkSecurityConfig` reference and `usesCleartextTraffic` |

Notes on specific tools:

- **Resource references** in the manifest (for example `@0x7f0e001a`) are returned as written. `resources.arsc` is not decoded, so a label such as `@string/app_name` is not resolved.
- **`apk_strings` regexes**: patterns are limited to 200 characters; patterns prone to catastrophic backtracking (nested quantifiers, quantified alternations, backreferences, more than three unbounded quantifiers) are refused; each string is tested on its first 512 characters.
- **`apk_find_secrets`** never returns a whole secret: values are masked as the first few characters, an ellipsis and the length (for example `AKIA…[20]`). URLs are returned without query string or fragment, and credentials embedded in a URL are reported only as a masked finding. A match is a lead, not proof that a secret is live.
- **`apk_signature`** parses certificates but performs **no cryptographic verification** (`verified: false`, with a `note`). It does not prove the APK is intact or who signed it.

## Result format

All results are JSON with `"untrusted": true` at the root and in `_meta`. Errors have the form `{"untrusted": true, "error": "..."}` and are returned as tool errors; the server never throws to the client.

## Security model

- **Read-only.** All tools carry `readOnlyHint: true` and `openWorldHint: false`.
- **Nothing is executed.** The APK is only parsed. Nothing is extracted to disk, and no network request is made.
- **Everything returned is untrusted data.** Strings, class names, manifest values, certificate fields and URLs come from the analysed file and may contain text written to manipulate an AI agent. They are data, never instructions. The server's `instructions` say so, and so should any agent using it.
- **Defence in depth against hostile files.** Every offset and length read from the file is bounds-checked. Limits: file up to 1 GiB, 100,000 ZIP entries, 64 MiB decompressed per DEX, 8 MiB per other entry (zip bombs are refused whether the declared size is honest or not), at most 1 MiB per text entry in the secret scan, 500 secret findings, 30 seconds of work per call. A malformed APK yields an error result, not a crash, a hang or a huge allocation.

## Limits

- Static analysis only: no decompilation to Java/Kotlin/smali, no method or instruction analysis, no call graphs.
- No resource-table decoding (`resources.arsc`).
- Only single `.apk` files. Android App Bundles (`.aab`), `.apks` sets and `.xapk` bundles are refused with an error naming the format.
- No cryptographic signature or digest verification.
- The network security config is found at its conventional path `res/xml/network_security_config.xml`; a renamed or obfuscated resource path is not followed.
- Exported-state inference follows the documented defaults (an intent filter without `android:exported` means exported below targetSdk 31). It is a static reading of the manifest, not a runtime check.
- Encrypted ZIP entries and compression methods other than stored and deflate are not supported.

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
