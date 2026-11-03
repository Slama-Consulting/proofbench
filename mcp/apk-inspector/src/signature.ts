import { X509Certificate } from "node:crypto";
import { ApkError, LIMITS } from "./errors.js";
import type { ZipArchive } from "./zip.js";

export const SIG_BLOCK_IDS = {
  v2: 0x7109871a,
  v3: 0xf05368c0,
  v31: 0x1b93ad61,
} as const;

const OTHER_BLOCKS: Record<number, string> = {
  0x42726577: "verity-padding",
  0x6dff800d: "source-stamp-v1",
  0x504b4453: "source-stamp-v2",
  0x2146444e: "google-play-frosting",
  0x71777777: "dependency-info",
};

// ---- minimal DER walker -------------------------------------------------

export interface Tlv {
  tag: number;
  /** Offset of the tag byte. */
  start: number;
  /** Offset of the first content byte. */
  body: number;
  /** Offset just after the content. */
  end: number;
}

export function readTlv(buf: Buffer, off: number, limit: number): Tlv {
  if (off + 2 > limit || limit > buf.length) throw new ApkError("DER: truncated element");
  const tag = buf[off]!;
  if ((tag & 0x1f) === 0x1f) throw new ApkError("DER: multi-byte tags are not supported");
  let len = buf[off + 1]!;
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new ApkError("DER: indefinite lengths are not supported");
    if (n > 4 || p + n > limit) throw new ApkError("DER: bad length encoding");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]!;
  }
  if (p + len > limit) throw new ApkError("DER: element runs past its container");
  return { tag, start: off, body: p, end: p + len };
}

export function derChildren(buf: Buffer, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = t.body;
  while (p < t.end) {
    const c = readTlv(buf, p, t.end);
    out.push(c);
    p = c.end;
    if (out.length > 10_000) throw new ApkError("DER: too many elements");
  }
  return out;
}

function oidString(buf: Buffer, t: Tlv): string {
  const parts: number[] = [];
  let v = 0;
  for (let i = t.body; i < t.end; i++) {
    const b = buf[i]!;
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      if (parts.length === 0) {
        const first = v < 80 ? Math.floor(v / 40) : 2;
        parts.push(first, v - first * 40);
      } else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

const SIG_ALGS: Record<string, string> = {
  "1.2.840.113549.1.1.4": "md5WithRSAEncryption",
  "1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
  "1.2.840.113549.1.1.10": "RSASSA-PSS",
  "1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
  "1.2.840.113549.1.1.12": "sha384WithRSAEncryption",
  "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.2.840.10045.4.1": "ecdsa-with-SHA1",
  "1.2.840.10045.4.3.2": "ecdsa-with-SHA256",
  "1.2.840.10045.4.3.3": "ecdsa-with-SHA384",
  "1.2.840.10045.4.3.4": "ecdsa-with-SHA512",
  "1.2.840.10040.4.3": "dsa-with-sha1",
  "2.16.840.1.101.3.4.3.2": "dsa-with-sha256",
  "1.3.101.112": "Ed25519",
};

/** Signature algorithm of a certificate, read from its DER (Node does not expose it). */
export function signatureAlgorithmOf(der: Buffer): string | null {
  try {
    const cert = readTlv(der, 0, der.length);
    const kids = derChildren(der, cert);
    const algo = kids[1];
    if (!algo) return null;
    const oid = derChildren(der, algo)[0];
    if (!oid || oid.tag !== 0x06) return null;
    const s = oidString(der, oid);
    return SIG_ALGS[s] ?? s;
  } catch {
    return null;
  }
}

// ---- certificates -------------------------------------------------------

export interface CertInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  serialNumber: string;
  sha256: string;
  sha1: string;
  publicKey: { type: string; sizeBits: number | null; curve?: string };
  signatureAlgorithm: string | null;
  expired: boolean;
  notYetValid: boolean;
  selfSigned: boolean;
  isDebugCertificate: boolean;
}

const oneLine = (s: string): string => s.split(/\r?\n/).join(", ");
const iso = (s: string): string => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};

export function describeCertificate(der: Buffer, now: Date = new Date()): CertInfo {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(der);
  } catch {
    throw new ApkError("certificate could not be parsed");
  }
  const subject = oneLine(cert.subject);
  const issuer = oneLine(cert.issuer);
  const from = new Date(cert.validFrom);
  const to = new Date(cert.validTo);
  const key = cert.publicKey;
  const details = key.asymmetricKeyDetails ?? {};
  const pk: CertInfo["publicKey"] = {
    type: key.asymmetricKeyType ?? "unknown",
    sizeBits: details.modulusLength ?? (details.namedCurve === "prime256v1" ? 256 : details.namedCurve === "secp384r1" ? 384 : details.namedCurve === "secp521r1" ? 521 : null),
  };
  if (details.namedCurve) pk.curve = details.namedCurve;
  return {
    subject,
    issuer,
    validFrom: iso(cert.validFrom),
    validTo: iso(cert.validTo),
    serialNumber: cert.serialNumber,
    sha256: cert.fingerprint256,
    sha1: cert.fingerprint,
    publicKey: pk,
    signatureAlgorithm: signatureAlgorithmOf(der),
    expired: !Number.isNaN(to.getTime()) && now > to,
    notYetValid: !Number.isNaN(from.getTime()) && now < from,
    selfSigned: subject === issuer,
    isDebugCertificate: subject.includes("CN=Android Debug"),
  };
}

/** Extracts the DER certificates of a PKCS#7 SignedData blob (the META-INF/*.RSA|DSA|EC file). */
export function certificatesFromPkcs7(buf: Buffer): Buffer[] {
  const top = readTlv(buf, 0, buf.length);
  if (top.tag !== 0x30) throw new ApkError("PKCS#7: not a DER sequence");
  const ci = derChildren(buf, top);
  const explicit = ci.find((c) => c.tag === 0xa0);
  if (!explicit) throw new ApkError("PKCS#7: no content");
  const signedData = derChildren(buf, explicit)[0];
  if (!signedData || signedData.tag !== 0x30) throw new ApkError("PKCS#7: SignedData missing");
  const set = derChildren(buf, signedData).find((c) => c.tag === 0xa0);
  if (!set) return [];
  const out: Buffer[] = [];
  for (const c of derChildren(buf, set)) if (c.tag === 0x30) out.push(Buffer.from(buf.subarray(c.start, c.end)));
  return out;
}

// ---- APK signing block --------------------------------------------------

export interface SigningBlockPair {
  id: number;
  /** Offset of the value in the file and its length. */
  offset: number;
  length: number;
}

const MAGIC = "APK Sig Block 42";

/** Finds the APK Signing Block that precedes the central directory, if any. */
export function findSigningBlock(zip: ZipArchive): SigningBlockPair[] | null {
  const src = zip.source;
  const cd = zip.centralDirectoryOffset;
  if (cd < 32) return null;
  const footer = src.read(cd - 24, 24);
  if (footer.toString("latin1", 8, 24) !== MAGIC) return null;
  const sizeOfBlock = Number(footer.readBigUInt64LE(0)); // excludes the leading size field
  if (!Number.isSafeInteger(sizeOfBlock) || sizeOfBlock < 24 || sizeOfBlock > LIMITS.maxSigningBlockBytes || sizeOfBlock + 8 > cd) throw new ApkError("APK Signing Block has an invalid size");
  const start = cd - sizeOfBlock - 8;
  const head = src.read(start, 8);
  if (Number(head.readBigUInt64LE(0)) !== sizeOfBlock) throw new ApkError("APK Signing Block size fields disagree");
  const pairs: SigningBlockPair[] = [];
  let p = start + 8;
  const end = cd - 24;
  while (p < end) {
    if (p + 12 > end) throw new ApkError("APK Signing Block has a truncated pair");
    const h = src.read(p, 12);
    const len = Number(h.readBigUInt64LE(0));
    if (!Number.isSafeInteger(len) || len < 4 || p + 8 + len > end) throw new ApkError("APK Signing Block pair has an invalid length");
    pairs.push({ id: h.readUInt32LE(8), offset: p + 12, length: len - 4 });
    p += 8 + len;
    if (pairs.length > 1000) throw new ApkError("APK Signing Block has too many pairs");
  }
  return pairs;
}

/** Cursor over length-prefixed (u32) sequences, with bounds checks. */
class Seq {
  constructor(
    private readonly b: Buffer,
    public pos: number,
    readonly end: number,
  ) {}
  u32(): number {
    if (this.pos + 4 > this.end) throw new ApkError("signing block: truncated value");
    const v = this.b.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  /** Reads a u32 length and returns a sub-cursor over that many bytes. */
  sub(): Seq {
    const len = this.u32();
    if (this.pos + len > this.end) throw new ApkError("signing block: length-prefixed value runs past its container");
    const s = new Seq(this.b, this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  bytes(): Buffer {
    const s = this.sub();
    return Buffer.from(this.b.subarray(s.pos, s.end));
  }
}

export interface BlockSigner {
  certificates: Buffer[];
  minSdk?: number;
  maxSdk?: number;
  hasRotationProof?: boolean;
}

const ATTR_ROTATION = 0x3ba06f8c;

export function parseSignersBlock(value: Buffer, version: 2 | 3): BlockSigner[] {
  const signers = new Seq(value, 0, value.length).sub();
  const out: BlockSigner[] = [];
  while (!signers.done) {
    if (out.length > 64) throw new ApkError("signing block: too many signers");
    const signer = signers.sub();
    const signed = signer.sub();
    signed.sub(); // digests
    const certs = signed.sub();
    const list: Buffer[] = [];
    while (!certs.done) {
      if (list.length > 64) throw new ApkError("signing block: too many certificates");
      list.push(certs.bytes());
    }
    const s: BlockSigner = { certificates: list };
    if (version === 3) {
      s.minSdk = signed.u32();
      s.maxSdk = signed.u32();
      try {
        const attrs = signed.sub();
        while (!attrs.done) {
          const a = attrs.sub();
          if (a.u32() === ATTR_ROTATION) s.hasRotationProof = true;
        }
      } catch {
        // optional attributes: ignore damage here
      }
    }
    out.push(s);
  }
  return out;
}

export interface SignatureReport {
  verified: false;
  note: string;
  v1: { present: boolean; files: string[]; signers: { file: string; certificates: CertInfo[]; error?: string }[] };
  v2: { present: boolean; signers: { certificates: CertInfo[]; error?: string }[]; error?: string };
  v3: { present: boolean; signers: { minSdk?: number; maxSdk?: number; hasRotationProof?: boolean; certificates: CertInfo[]; error?: string }[]; error?: string };
  v31: { present: boolean; signers: { minSdk?: number; maxSdk?: number; hasRotationProof?: boolean; certificates: CertInfo[]; error?: string }[]; error?: string };
  otherSigningBlockEntries: string[];
  signingBlockError?: string;
}

export const SIGNATURE_NOTE =
  "Certificates are parsed from the file, but no signature or digest is verified cryptographically: this does not prove the APK is intact or that it was signed by the certificate shown.";

function certs(ders: Buffer[]): { certificates: CertInfo[]; error?: string } {
  const certificates: CertInfo[] = [];
  let error: string | undefined;
  for (const d of ders) {
    try {
      certificates.push(describeCertificate(d));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return error ? { certificates, error } : { certificates };
}

export function readSignatures(zip: ZipArchive): SignatureReport {
  const names = zip.entries.map((e) => e.name).filter((n) => /^META-INF\/[^/]+$/i.test(n));
  const blockFiles = names.filter((n) => /\.(RSA|DSA|EC)$/i.test(n));
  const v1Files = names.filter((n) => /\.(RSA|DSA|EC|SF)$/i.test(n) || /\/MANIFEST\.MF$/i.test(n)).sort();
  const v1Signers = blockFiles.map((file) => {
    try {
      const data = zip.read(zip.get(file)!, 1024 * 1024);
      return { file, ...certs(certificatesFromPkcs7(data)) };
    } catch (e) {
      return { file, certificates: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  const hasSf = names.some((n) => /\.SF$/i.test(n));

  const report: SignatureReport = {
    verified: false,
    note: SIGNATURE_NOTE,
    v1: { present: hasSf && blockFiles.length > 0, files: v1Files, signers: v1Signers },
    v2: { present: false, signers: [] },
    v3: { present: false, signers: [] },
    v31: { present: false, signers: [] },
    otherSigningBlockEntries: [],
  };

  let pairs: SigningBlockPair[] | null = null;
  try {
    pairs = findSigningBlock(zip);
  } catch (e) {
    report.signingBlockError = e instanceof Error ? e.message : String(e);
  }
  for (const pair of pairs ?? []) {
    const known = pair.id === SIG_BLOCK_IDS.v2 || pair.id === SIG_BLOCK_IDS.v3 || pair.id === SIG_BLOCK_IDS.v31;
    if (!known) {
      report.otherSigningBlockEntries.push(OTHER_BLOCKS[pair.id] ?? "0x" + pair.id.toString(16));
      continue;
    }
    if (pair.length > 16 * 1024 * 1024) {
      const slot = pair.id === SIG_BLOCK_IDS.v2 ? report.v2 : pair.id === SIG_BLOCK_IDS.v3 ? report.v3 : report.v31;
      slot.present = true;
      slot.error = "signature block value is too large to parse";
      continue;
    }
    const value = zip.source.read(pair.offset, pair.length);
    if (pair.id === SIG_BLOCK_IDS.v2) {
      report.v2.present = true;
      try {
        report.v2.signers = parseSignersBlock(value, 2).map((s) => certs(s.certificates));
      } catch (e) {
        report.v2.error = e instanceof Error ? e.message : String(e);
      }
    } else {
      const slot = pair.id === SIG_BLOCK_IDS.v3 ? report.v3 : report.v31;
      slot.present = true;
      try {
        slot.signers = parseSignersBlock(value, 3).map((s) => ({
          ...(s.minSdk !== undefined ? { minSdk: s.minSdk } : {}),
          ...(s.maxSdk !== undefined ? { maxSdk: s.maxSdk } : {}),
          ...(s.hasRotationProof ? { hasRotationProof: true } : {}),
          ...certs(s.certificates),
        }));
      } catch (e) {
        slot.error = e instanceof Error ? e.message : String(e);
      }
    }
  }
  return report;
}

/** Which schemes exist, without parsing certificates. */
export function signingSchemes(zip: ZipArchive): { v1: boolean; v2: boolean; v3: boolean; v31: boolean } {
  const names = zip.entries.map((e) => e.name);
  const v1 = names.some((n) => /^META-INF\/[^/]+\.SF$/i.test(n)) && names.some((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n));
  let ids: number[] = [];
  try {
    ids = (findSigningBlock(zip) ?? []).map((p) => p.id);
  } catch {
    // malformed block: reported by apk_signature
  }
  return { v1, v2: ids.includes(SIG_BLOCK_IDS.v2), v3: ids.includes(SIG_BLOCK_IDS.v3), v31: ids.includes(SIG_BLOCK_IDS.v31) };
}
