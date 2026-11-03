import type { DexSpec } from "./dexwriter.js";

/** A DEX spec with only the given strings and one class. */
export function dexSpecWith(strings: string[]): DexSpec {
  return { strings, classes: [{ name: "com.example.Only" }] };
}
