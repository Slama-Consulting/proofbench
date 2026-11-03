import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

// ---- DER encoding ---------------------------------------------------------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
export const tlv = (tag: number, ...body: Buffer[]): Buffer => {
  const b = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), len(b.length), b]);
};
export const seq = (...b: Buffer[]): Buffer => tlv(0x30, ...b);
export const set = (...b: Buffer[]): Buffer => tlv(0x31, ...b);
export const int = (n: number | Buffer): Buffer => {
  let b = typeof n === "number" ? Buffer.from([n]) : n;
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
export const oid = (dotted: string): Buffer => {
  const p = dotted.split(".").map(Number);
  const out: number[] = [p[0]! * 40 + p[1]!];
  for (const n of p.slice(2)) {
    const chunk: number[] = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s));
const utcTime = (d: Date): Buffer => {
  const p = (n: number): string => String(n).padStart(2, "0");
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const name = (cn: string): Buffer => seq(set(seq(oid("2.5.4.3"), utf8(cn))));

export interface TestCert {
  der: Buffer;
  subject: string;
}

export interface CertOptions {
  cn?: string;
  issuerCn?: string;
  alg?: "ec" | "rsa";
  notBefore?: Date;
  notAfter?: Date;
}

const keyCache = new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>();
function keys(alg: "ec" | "rsa") {
  let k = keyCache.get(alg);
  if (!k) {
    k = alg === "ec" ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyCache.set(alg, k);
  }
  return k;
}

/** Builds a signed X.509 v3 certificate by hand (no external tool). Self-signed unless `issuerCn` differs. */
export function makeCert(o: CertOptions = {}): TestCert {
  const cn = o.cn ?? "Test Signer";
  const alg = o.alg ?? "ec";
  const { publicKey, privateKey } = keys(alg);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const sigAlg = alg === "ec" ? seq(oid("1.2.840.10045.4.3.2")) : seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));
  const tbs = seq(
    tlv(0xa0, int(2)),
    int(Buffer.from([0x01, 0x02, 0x03, 0x04])),
    sigAlg,
    name(o.issuerCn ?? cn),
    seq(utcTime(o.notBefore ?? new Date("2020-01-01T00:00:00Z")), utcTime(o.notAfter ?? new Date("2049-01-01T00:00:00Z"))),
    name(cn),
    spki,
  );
  const signature = alg === "ec" ? sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" }) : sign("sha256", tbs, privateKey);
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.from([0]), signature));
  return { der, subject: cn };
}

/** A minimal PKCS#7 SignedData carrying the certificate, like META-INF/CERT.RSA. */
export function pkcs7(cert: Buffer): Buffer {
  const signedData = seq(int(1), set(), seq(oid("1.2.840.113549.1.7.1")), tlv(0xa0, cert), set());
  return seq(oid("1.2.840.113549.1.7.2"), tlv(0xa0, signedData));
}

// ---- APK signing block values ---------------------------------------------

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const lp = (...b: Buffer[]): Buffer => {
  const body = Buffer.concat(b);
  return Buffer.concat([u32(body.length), body]);
};

export function v2Value(certs: Buffer[]): Buffer {
  const signedData = Buffer.concat([lp(), lp(...certs.map((c) => lp(c))), lp()]);
  return lp(lp(lp(signedData), lp(), lp()));
}

export function v3Value(certs: Buffer[], minSdk = 28, maxSdk = 0x7fffffff, rotation = false): Buffer {
  const attrs = rotation ? lp(lp(u32(0x3ba06f8c), Buffer.from("proof"))) : lp();
  const signedData = Buffer.concat([lp(), lp(...certs.map((c) => lp(c))), u32(minSdk), u32(maxSdk), attrs]);
  return lp(lp(lp(signedData), u32(minSdk), u32(maxSdk), lp(), lp()));
}
