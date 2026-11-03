/** An expected failure caused by the input file or arguments. Its message is safe to show. */
export class ApkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApkError";
  }
}

/** Hard limits that defend against hostile input. */
export const LIMITS = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxEntries: 100_000,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxDexBytes: 64 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTextScanBytes: 1024 * 1024,
  maxSigningBlockBytes: 64 * 1024 * 1024,
  maxSecretFindings: 500,
  maxStringChars: 300,
  workMs: 30_000,
};

/** A wall-clock budget checked by the parsers inside their loops. */
export class Deadline {
  private readonly end: number;
  private ticks = 0;
  constructor(ms: number = LIMITS.workMs) {
    this.end = Date.now() + ms;
  }
  /** Cheap to call often: the clock is read once every 1024 calls. */
  tick(): void {
    if ((++this.ticks & 1023) === 0) this.check();
  }
  check(): void {
    if (Date.now() > this.end) throw new ApkError("time limit exceeded while analysing the file");
  }
}
