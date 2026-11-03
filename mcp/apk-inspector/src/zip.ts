import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { constants as zc, inflateRawSync } from "node:zlib";
import { ApkError, LIMITS } from "./errors.js";

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;

/** Random-access, bounds-checked reader over a file descriptor. Never loads the whole file. */
export class FileSource {
  readonly size: number;
  private fd: number | null;

  constructor(readonly path: string) {
    this.fd = openSync(path, "r");
    this.size = fstatSync(this.fd).size;
  }

  read(offset: number, length: number): Buffer {
    if (this.fd === null) throw new ApkError("file already closed");
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new ApkError("invalid read range");
    if (offset + length > this.size) throw new ApkError("read beyond end of file (truncated or malformed archive)");
    const buf = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, buf, done, length - done, offset + done);
      if (n <= 0) throw new ApkError("unexpected end of file");
      done += n;
    }
    return buf;
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // already gone
      }
      this.fd = null;
    }
  }
}

function u64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApkError("64-bit value out of range");
  return Number(v);
}

export class ZipArchive {
  readonly byName = new Map<string, ZipEntry>();

  private constructor(
    readonly source: FileSource,
    readonly entries: ZipEntry[],
    /** Offset of the central directory: the APK Signing Block, if any, ends right before it. */
    readonly centralDirectoryOffset: number,
  ) {
    for (const e of entries) if (!this.byName.has(e.name)) this.byName.set(e.name, e);
  }

  static open(source: FileSource): ZipArchive {
    const size = source.size;
    if (size < 22) throw new ApkError("file is too small to be a ZIP archive");
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = source.read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        const commentLen = tail.readUInt16LE(i + 20);
        if (i + 22 + commentLen <= tail.length) {
          eocd = i;
          break;
        }
      }
    }
    if (eocd < 0) throw new ApkError("end of central directory not found (not a ZIP archive, or truncated)");
    const eocdAbs = size - tailLen + eocd;
    let total = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      if (eocdAbs < 20) throw new ApkError("zip64 locator missing");
      const loc = source.read(eocdAbs - 20, 20);
      if (loc.readUInt32LE(0) !== SIG_EOCD64_LOC) throw new ApkError("zip64 locator missing");
      const rec = source.read(u64(loc, 8), 56);
      if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new ApkError("zip64 end of central directory is malformed");
      total = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
    }

    if (total > LIMITS.maxEntries) throw new ApkError(`too many entries (${total}; limit ${LIMITS.maxEntries})`);
    if (cdSize > LIMITS.maxCentralDirectoryBytes) throw new ApkError("central directory is too large");
    if (cdOffset + cdSize > size) throw new ApkError("central directory lies beyond the end of the file (truncated or malformed archive)");
    const cd = source.read(cdOffset, cdSize);

    const entries: ZipEntry[] = [];
    let p = 0;
    while (entries.length < total) {
      if (p + 46 > cd.length) throw new ApkError("central directory is truncated");
      if (cd.readUInt32LE(p) !== SIG_CEN) throw new ApkError("central directory entry has a bad signature");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc32 = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nameLen + extraLen + commentLen;
      if (end > cd.length) throw new ApkError("central directory entry runs past the directory");
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        let q = p + 46 + nameLen;
        const extraEnd = q + extraLen;
        while (q + 4 <= extraEnd) {
          const id = cd.readUInt16LE(q);
          const len = cd.readUInt16LE(q + 2);
          if (q + 4 + len > extraEnd) break;
          if (id === 0x0001) {
            let r = q + 4;
            const lim = q + 4 + len;
            if (uncompressedSize === 0xffffffff && r + 8 <= lim) {
              uncompressedSize = u64(cd, r);
              r += 8;
            }
            if (compressedSize === 0xffffffff && r + 8 <= lim) {
              compressedSize = u64(cd, r);
              r += 8;
            }
            if (localHeaderOffset === 0xffffffff && r + 8 <= lim) localHeaderOffset = u64(cd, r);
          }
          q += 4 + len;
        }
      }
      entries.push({ name, method, flags, crc32, compressedSize, uncompressedSize, localHeaderOffset });
      p = end;
    }
    return new ZipArchive(source, entries, cdOffset);
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  private dataStart(entry: ZipEntry): number {
    const lh = this.source.read(entry.localHeaderOffset, 30);
    if (lh.readUInt32LE(0) !== SIG_LOC) throw new ApkError(`entry ${entry.name} has a bad local header`);
    const start = entry.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    if (start > this.source.size) throw new ApkError(`entry ${entry.name} data lies beyond the end of the file`);
    return start;
  }

  /** Decompresses one entry in memory, refusing anything that would exceed `maxBytes`. */
  read(entry: ZipEntry, maxBytes: number = LIMITS.maxEntryBytes): Buffer {
    if (entry.flags & 1) throw new ApkError(`entry ${entry.name} is encrypted`);
    if (entry.uncompressedSize > maxBytes) throw new ApkError(`entry ${entry.name} is too large (declared ${entry.uncompressedSize} bytes; limit ${maxBytes})`);
    const start = this.dataStart(entry);
    if (start + entry.compressedSize > this.source.size) throw new ApkError(`entry ${entry.name} data lies beyond the end of the file`);
    if (entry.compressedSize > maxBytes) throw new ApkError(`entry ${entry.name} is too large`);
    if (entry.method === 0) return this.source.read(start, entry.compressedSize);
    if (entry.method === 8) {
      const comp = this.source.read(start, entry.compressedSize);
      try {
        return inflateRawSync(comp, { maxOutputLength: maxBytes });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE") throw new ApkError(`entry ${entry.name} expands beyond the limit of ${maxBytes} bytes (possible zip bomb)`);
        throw new ApkError(`entry ${entry.name} is corrupt (cannot inflate)`);
      }
    }
    throw new ApkError(`entry ${entry.name} uses unsupported compression method ${entry.method}`);
  }

  /** The first bytes of an entry, for magic-number sniffing. Returns an empty buffer when unreadable. */
  peek(entry: ZipEntry, n: number): Buffer {
    try {
      if (entry.flags & 1) return Buffer.alloc(0);
      const start = this.dataStart(entry);
      const avail = Math.max(0, this.source.size - start);
      if (entry.method === 0) return this.source.read(start, Math.min(n, entry.compressedSize, avail));
      if (entry.method === 8) {
        // A small compressed prefix is enough for a few magic bytes and bounds the output (<= ~1032:1).
        const comp = this.source.read(start, Math.min(512, entry.compressedSize, avail));
        return inflateRawSync(comp, { maxOutputLength: 1024 * 1024, finishFlush: zc.Z_SYNC_FLUSH }).subarray(0, n);
      }
    } catch {
      // unreadable: no magic
    }
    return Buffer.alloc(0);
  }
}
