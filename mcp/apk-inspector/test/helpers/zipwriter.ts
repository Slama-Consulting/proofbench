import { deflateRawSync } from "node:zlib";

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipFile {
  name: string;
  data: Buffer | string;
  method?: "store" | "deflate";
}

export interface ZipOptions {
  /** Bytes inserted between the last entry and the central directory (an APK Signing Block). */
  beforeCentralDirectory?: Buffer;
  comment?: string;
}

export function buildZip(files: ZipFile[], opts: ZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const method = f.method === "store" ? 0 : 8;
    const comp = method === 0 ? data : deflateRawSync(data);
    const name = Buffer.from(f.name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  if (opts.beforeCentralDirectory) {
    parts.push(opts.beforeCentralDirectory);
    offset += opts.beforeCentralDirectory.length;
  }
  const cd = Buffer.concat(central);
  const comment = Buffer.from(opts.comment ?? "");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, eocd, comment]);
}

/** An APK Signing Block holding the given id/value pairs. */
export function buildSigningBlock(pairs: { id: number; value: Buffer }[]): Buffer {
  const body = Buffer.concat(
    pairs.map((p) => {
      const h = Buffer.alloc(12);
      h.writeBigUInt64LE(BigInt(4 + p.value.length), 0);
      h.writeUInt32LE(p.id, 8);
      return Buffer.concat([h, p.value]);
    }),
  );
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(body.length + 8 + 16));
  return Buffer.concat([size, body, size, Buffer.from("APK Sig Block 42")]);
}
