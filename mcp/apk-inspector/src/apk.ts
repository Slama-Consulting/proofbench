import { isAbsolute } from "node:path";
import { openSync, closeSync, readSync, statSync } from "node:fs";
import { ApkError, Deadline, LIMITS } from "./errors.js";
import { DexFile, dexOrder, isDexName } from "./dex.js";
import { FileSource, ZipArchive, type ZipEntry } from "./zip.js";

/** An opened APK. Everything is read lazily from disk; nothing is extracted. */
export class Apk {
  readonly deadline = new Deadline();

  private constructor(
    readonly source: FileSource,
    readonly zip: ZipArchive,
  ) {}

  static open(path: unknown): Apk {
    if (typeof path !== "string" || path.length === 0) throw new ApkError("path must be a non-empty string");
    if (path.includes("\0")) throw new ApkError("path contains a NUL character");
    if (!isAbsolute(path)) throw new ApkError("path must be absolute");
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new ApkError("file not found or not readable");
    }
    if (!st.isFile()) throw new ApkError("path is not a regular file");
    if (st.size === 0) throw new ApkError("file is empty");
    if (st.size > LIMITS.maxFileBytes) throw new ApkError(`file is larger than the ${LIMITS.maxFileBytes / 1024 / 1024 / 1024} GiB limit`);
    const head = Buffer.alloc(4);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      throw new ApkError("file not found or not readable");
    }
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    // PK\3\4 (normal) or PK\5\6 (empty archive); anything else is not a ZIP.
    if (!(head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6)))) {
      throw new ApkError("not a ZIP archive (missing PK signature); an APK is a ZIP file");
    }
    const source = new FileSource(path);
    try {
      const zip = ZipArchive.open(source);
      const apk = new Apk(source, zip);
      apk.assertIsApk();
      return apk;
    } catch (e) {
      source.close();
      throw e;
    }
  }

  close(): void {
    this.source.close();
  }

  private assertIsApk(): void {
    const has = (n: string): boolean => this.zip.byName.has(n);
    if (has("AndroidManifest.xml")) return;
    const names = this.zip.entries.map((e) => e.name);
    if (has("BundleConfig.pb") || has("base/manifest/AndroidManifest.xml")) {
      throw new ApkError("unsupported format: this is an Android App Bundle (.aab), not an APK");
    }
    if (has("toc.pb")) throw new ApkError("unsupported format: this is an APK set (.apks), not a single APK");
    if (has("manifest.json") && names.some((n) => n.toLowerCase().endsWith(".apk"))) {
      throw new ApkError("unsupported format: this is an XAPK bundle, not a single APK; analyse the inner .apk files instead");
    }
    throw new ApkError("not an APK: AndroidManifest.xml is missing at the archive root");
  }

  readEntry(name: string, max: number = LIMITS.maxEntryBytes): Buffer {
    const e = this.zip.get(name);
    if (!e) throw new ApkError(`entry not found: ${name}`);
    return this.zip.read(e, max);
  }

  dexEntries(): ZipEntry[] {
    return this.zip.entries.filter((e) => isDexName(e.name)).sort((a, b) => dexOrder(a.name, b.name));
  }

  /** Opens each classes*.dex in turn; the buffer is released once `fn` returns. */
  forEachDex(fn: (dex: DexFile) => void): { errors: { file: string; error: string }[] } {
    const errors: { file: string; error: string }[] = [];
    for (const e of this.dexEntries()) {
      this.deadline.check();
      try {
        const buf = this.zip.read(e, LIMITS.maxDexBytes);
        fn(new DexFile(e.name, buf, this.deadline));
      } catch (err) {
        if (err instanceof ApkError && /time limit/.test(err.message)) throw err;
        errors.push({ file: e.name, error: err instanceof ApkError ? err.message : "unreadable DEX" });
      }
    }
    return { errors };
  }
}

/** Opens, runs, always closes. */
export function withApk<T>(path: unknown, fn: (apk: Apk) => T): T {
  const apk = Apk.open(path);
  try {
    return fn(apk);
  } finally {
    apk.close();
  }
}
