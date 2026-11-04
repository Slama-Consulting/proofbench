import type { Apk } from "./apk.js";
import { ApkError, LIMITS } from "./errors.js";
import { DexFile, accessNames, descriptorToName } from "./dex.js";
import { DexCode, invokeName, methodAccessNames, type ClassDef, type CodeItem, type DefinedMethod, type MethodRef } from "./bytecode.js";
import { readManifest } from "./manifest.js";
import type { ConstResult, KnownArg } from "./constants.js";

/**
 * Static reading of the code of an APK: which methods exist, what they call, who calls what, and whether the entry
 * points of exported components reach an API that looks at the caller. Nothing is executed. Everything is a lead.
 */

const MAX_TOTAL_DEX_BYTES = 256 * 1024 * 1024;
const MAX_VISITED = 3000;
const MAX_CLASSES_LISTED = 20;

export interface ClassInfo extends ClassDef {
  code: DexCode;
  methods?: DefinedMethod[];
  error?: string;
}

interface Def {
  ci: ClassInfo;
  m: DefinedMethod;
}

interface Call {
  op: number;
  opName: string;
  ref: MethodRef;
  regs: number[];
  /** Position of the instruction in the method, in code units. */
  unit: number;
}

interface MethodBody {
  code: CodeItem | null;
  instructions: number;
  complete: boolean;
  error?: string;
  calls: Call[];
  strings: string[];
  newInstances: string[];
  unresolvedRefs: number;
  reads: Map<number, number>;
}

const descriptorOf = (dotted: string): string => `L${dotted.replace(/\./g, "/")};`;

/** `(Ljava/lang/String;I[B)V` gives `["Ljava/lang/String;", "I", "[B"]`. */
export function paramTypes(proto: string): string[] {
  const inner = proto.slice(1, proto.indexOf(")"));
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    let j = i;
    while (inner[j] === "[") j++;
    if (inner[j] === "L") {
      j = inner.indexOf(";", j);
      if (j < 0) break;
    }
    out.push(inner.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

export class CodeIndex {
  readonly classes = new Map<string, ClassInfo>();
  readonly errors: { file: string; error: string }[] = [];
  private readonly bodies = new Map<DefinedMethod, MethodBody>();
  private readonly defCache = new Map<string, Def | null>();
  private readonly subCache = new Map<string, boolean>();
  private readonly constCache = new Map<DefinedMethod, ConstResult>();
  private implIndex: Map<string, ClassInfo[]> | undefined;

  private constructor(private readonly apk: Apk) {}

  static open(apk: Apk): CodeIndex {
    const idx = new CodeIndex(apk);
    let total = 0;
    for (const e of apk.dexEntries()) {
      apk.deadline.check();
      try {
        total += e.uncompressedSize;
        if (total > MAX_TOTAL_DEX_BYTES) throw new ApkError("the dex files together exceed the 256 MiB limit of the code analysis");
        const code = new DexCode(new DexFile(e.name, apk.zip.read(e, LIMITS.maxDexBytes), apk.deadline), apk.deadline);
        code.forEachClassDef((def) => {
          if (!idx.classes.has(def.descriptor)) idx.classes.set(def.descriptor, { ...def, code });
        });
      } catch (err) {
        if (err instanceof ApkError && /time limit/.test(err.message)) throw err;
        idx.errors.push({ file: e.name, error: err instanceof ApkError ? err.message : "unreadable DEX" });
      }
    }
    return idx;
  }

  methodsOf(ci: ClassInfo): DefinedMethod[] {
    if (ci.methods) return ci.methods;
    try {
      ci.methods = ci.code.methodsOf(ci);
    } catch (e) {
      ci.error = e instanceof ApkError ? e.message : "class data is unreadable";
      ci.methods = [];
    }
    return ci.methods;
  }

  /** The declaration of `name`+`proto` in `cls` or, failing that, in its superclasses and interfaces defined in the app. */
  findDefinition(cls: string, name: string, proto: string): Def | null {
    const key = `${cls}|${name}${proto}`;
    const cached = this.defCache.get(key);
    if (cached !== undefined) return cached;
    let found: Def | null = null;
    const seen = new Set<string>();
    const queue = [cls];
    while (queue.length && !found) {
      const d = queue.shift()!;
      if (seen.has(d)) continue;
      seen.add(d);
      const ci = this.classes.get(d);
      if (!ci) continue;
      const m = this.methodsOf(ci).find((x) => x.ref.name === name && x.ref.proto === proto);
      if (m) found = { ci, m };
      else {
        if (ci.superDescriptor) queue.push(ci.superDescriptor);
        queue.push(...ci.interfaces);
      }
    }
    this.defCache.set(key, found);
    return found;
  }

  /** True when `desc` is `target` or reaches it through superclasses and interfaces (types outside the app end the climb). */
  isSubtype(desc: string, target: string): boolean {
    if (desc === target) return true;
    const key = `${desc}|${target}`;
    const cached = this.subCache.get(key);
    if (cached !== undefined) return cached;
    let result = false;
    const seen = new Set<string>();
    const queue = [desc];
    while (queue.length && !result) {
      const d = queue.shift()!;
      if (seen.has(d)) continue;
      seen.add(d);
      if (d === target) {
        result = true;
        break;
      }
      const ci = this.classes.get(d);
      if (!ci) continue;
      if (ci.superDescriptor) queue.push(ci.superDescriptor);
      queue.push(...ci.interfaces);
    }
    this.subCache.set(key, result);
    return result;
  }

  /** App methods named `name`+`proto` declared by subtypes of `cls`. */
  implementations(cls: string, name: string, proto: string): Def[] {
    if (!this.implIndex) {
      this.implIndex = new Map();
      for (const ci of this.classes.values()) {
        this.apk.deadline.tick();
        for (const m of this.methodsOf(ci)) {
          if (m.codeOff === 0) continue;
          const key = `${m.ref.name}${m.ref.proto}`;
          const list = this.implIndex.get(key);
          if (list) list.push(ci);
          else this.implIndex.set(key, [ci]);
        }
      }
    }
    const out: Def[] = [];
    for (const ci of this.implIndex.get(`${name}${proto}`) ?? []) {
      if (ci.descriptor === cls || !this.isSubtype(ci.descriptor, cls)) continue;
      const m = this.methodsOf(ci).find((x) => x.ref.name === name && x.ref.proto === proto && x.codeOff !== 0);
      if (m) out.push({ ci, m });
    }
    return out;
  }

  /** What one method does, read from its instructions. Cached unless `cache` is false. */
  body(ci: ClassInfo, m: DefinedMethod, cache = true): MethodBody {
    const hit = this.bodies.get(m);
    if (hit) return hit;
    const body: MethodBody = { code: null, instructions: 0, complete: true, calls: [], strings: [], newInstances: [], unresolvedRefs: 0, reads: new Map() };
    try {
      const code = ci.code.codeItem(m);
      body.code = code;
      if (code) {
        const walked = ci.code.walk(code, {
          invoke: (opcode, methodIdx, regs, unit) => {
            const ref = ci.code.methodRef(methodIdx);
            if (ref) body.calls.push({ op: opcode, opName: invokeName(opcode), ref, regs, unit });
            else body.unresolvedRefs++;
          },
          constString: (idx) => {
            const s = ci.code.string(idx);
            if (s === null) body.unresolvedRefs++;
            else body.strings.push(s);
          },
          newInstance: (idx) => {
            const d = ci.code.typeDescriptor(idx);
            if (d === null) body.unresolvedRefs++;
            else body.newInstances.push(d);
          },
          read: (reg) => body.reads.set(reg, (body.reads.get(reg) ?? 0) + 1),
        });
        body.instructions = walked.instructions;
        body.complete = walked.complete;
        if (walked.error) body.error = walked.error;
      }
    } catch (e) {
      if (e instanceof ApkError && /time limit/.test(e.message)) throw e;
      body.complete = false;
      body.error = e instanceof ApkError ? e.message : "code is unreadable";
    }
    if (cache) this.bodies.set(m, body);
    return body;
  }

  /** The constants certainly held by the arguments of each call of a method (see constants.ts). */
  constants(ci: ClassInfo, m: DefinedMethod, body: MethodBody): ConstResult {
    const hit = this.constCache.get(m);
    if (hit) return hit;
    let result: ConstResult = { sites: new Map(), complete: true };
    if (body.code) {
      try {
        result = ci.code.constants(body.code);
      } catch (e) {
        if (e instanceof ApkError && /time limit/.test(e.message)) throw e;
        result = { sites: new Map(), complete: false };
      }
    }
    this.constCache.set(m, result);
    return result;
  }

  /** The app methods a call can reach. Empty when the callee lives outside the app. */
  targets(body: MethodBody, call: Call): Def[] {
    const out = new Map<DefinedMethod, Def>();
    const add = (d: Def | null): void => {
      if (d && d.m.codeOff !== 0) out.set(d.m, d);
    };
    const { cls, name, proto } = call.ref;
    add(this.findDefinition(cls, name, proto));
    const dispatch = call.op === 0x6e || call.op === 0x72 || call.op === 0x74 || call.op === 0x78;
    if (dispatch) {
      if (this.classes.has(cls)) for (const d of this.implementations(cls, name, proto)) add(d);
      // A lambda or anonymous class built by this very method and called through its (library) interface.
      for (const inst of body.newInstances) if (this.classes.has(inst) && this.isSubtype(inst, cls)) add(this.findDefinition(inst, name, proto));
    }
    return [...out.values()];
  }

  /** True when no app code declares the callee: it is framework or library code. */
  isExternal(call: Call): boolean {
    return this.findDefinition(call.ref.cls, call.ref.name, call.ref.proto) === null;
  }
}

// ---- tools --------------------------------------------------------------

const codeSummary = (ci: ClassInfo, m: DefinedMethod): object | null => {
  try {
    const c = ci.code.codeItem(m);
    return c ? { registers: c.registers, ins: c.ins, outs: c.outs, units: c.units } : null;
  } catch (e) {
    return { error: e instanceof ApkError ? e.message : "code is unreadable" };
  }
};

export function apkMethods(apk: Apk, o: { cls: string; limit: number }): object {
  const index = CodeIndex.open(apk);
  const needle = o.cls.toLowerCase();
  const matched = [...index.classes.values()].filter((ci) => descriptorToName(ci.descriptor).toLowerCase().includes(needle));
  let returned = 0;
  let truncated = false;
  const classes = matched.slice(0, MAX_CLASSES_LISTED).map((ci) => {
    const all = index.methodsOf(ci);
    const room = Math.max(0, o.limit - returned);
    if (all.length > room) truncated = true;
    const methods = all.slice(0, room).map((m) => ({
      name: m.ref.name,
      proto: m.ref.proto,
      sig: m.ref.sig,
      access: methodAccessNames(m.accessFlags),
      kind: m.direct ? "direct" : "virtual",
      code: codeSummary(ci, m),
    }));
    returned += methods.length;
    return {
      name: descriptorToName(ci.descriptor),
      dex: ci.code.name,
      superclass: ci.superDescriptor ? descriptorToName(ci.superDescriptor) : null,
      interfaces: ci.interfaces.map(descriptorToName),
      access: accessNames(ci.accessFlags),
      methods,
      ...(ci.error ? { error: ci.error } : {}),
    };
  });
  return { matchedClasses: matched.length, truncatedClasses: matched.length > MAX_CLASSES_LISTED, returnedMethods: returned, truncated, classes, ...(index.errors.length ? { dexErrors: index.errors } : {}) };
}

interface ParamInfo {
  index: number;
  type: string;
  register: number;
  readCount: number;
  passedTo: string[];
}

function parametersOf(m: DefinedMethod, body: MethodBody): ParamInfo[] {
  if (!body.code) return [];
  const isStatic = (m.accessFlags & 0x8) !== 0;
  let reg = body.code.registers - body.code.ins + (isStatic ? 0 : 1);
  return paramTypes(m.ref.proto).map((type, index) => {
    const here = reg;
    reg += type === "J" || type === "D" ? 2 : 1;
    const passed = new Set<string>();
    for (const c of body.calls) if (c.regs.includes(here)) passed.add(c.ref.sig);
    return { index, type, register: here, readCount: body.reads.get(here) ?? 0, passedTo: [...passed] };
  });
}

interface Visited {
  def: Def;
  body: MethodBody;
  level: number;
  parent: Visited | null;
}

/** Breadth-first walk of the app methods reachable from `starts`, `levels` bodies deep (the start is level 1). */
function reach(index: CodeIndex, starts: Def[], levels: number): Visited[] {
  const seen = new Set<DefinedMethod>();
  const out: Visited[] = [];
  const queue: Visited[] = [];
  for (const d of starts) {
    if (seen.has(d.m)) continue;
    seen.add(d.m);
    queue.push({ def: d, body: index.body(d.ci, d.m), level: 1, parent: null });
  }
  while (queue.length && out.length < MAX_VISITED) {
    const v = queue.shift()!;
    out.push(v);
    if (v.level >= levels) continue;
    for (const call of v.body.calls) {
      for (const t of index.targets(v.body, call)) {
        if (seen.has(t.m)) continue;
        seen.add(t.m);
        queue.push({ def: t, body: index.body(t.ci, t.m), level: v.level + 1, parent: v });
      }
    }
  }
  return out;
}

const chainOf = (v: Visited): string[] => {
  const out: string[] = [];
  for (let x: Visited | null = v; x; x = x.parent) out.unshift(x.def.m.ref.sig);
  return out;
};

function callSummary(index: CodeIndex, body: MethodBody): { callee: string; op: string; inApp: boolean; count: number }[] {
  const map = new Map<string, { callee: string; op: string; inApp: boolean; count: number }>();
  for (const c of body.calls) {
    const key = `${c.opName} ${c.ref.sig}`;
    const hit = map.get(key);
    if (hit) hit.count++;
    else map.set(key, { callee: c.ref.sig, op: c.opName, inApp: index.classes.has(c.ref.cls), count: 1 });
  }
  return [...map.values()];
}

const unique = <T>(xs: T[], max: number): T[] => [...new Set(xs)].slice(0, max);

const MAX_CONST_SITES = 200;

/** Constants passed to calls: only call sites with at least one known argument are listed. */
function callConstants(index: CodeIndex, ci: ClassInfo, m: DefinedMethod, body: MethodBody): { callConstants: object[]; constantsComplete: boolean } {
  const r = index.constants(ci, m, body);
  const sites: object[] = [];
  for (const c of body.calls) {
    const known = r.sites.get(c.unit);
    if (known && sites.length < MAX_CONST_SITES) sites.push({ callee: c.ref.sig, op: c.opName, known });
  }
  return { callConstants: sites, constantsComplete: r.complete };
}

const describeArg = (k: KnownArg): string => (k.string !== undefined ? `arg${k.arg}=${JSON.stringify(k.string.length > 60 ? k.string.slice(0, 60) + "…" : k.string)}` : `arg${k.arg}=${k.hex}`);

export function apkCalls(apk: Apk, o: { cls: string; method: string; depth?: number | undefined }): object {
  const index = CodeIndex.open(apk);
  const ci = index.classes.get(descriptorOf(o.cls));
  const candidates = ci ? index.methodsOf(ci).filter((m) => m.ref.name === o.method) : [];
  const matches = candidates.map((m) => {
    const body = index.body(ci!, m);
    const code = body.code ? { registers: body.code.registers, ins: body.code.ins, outs: body.code.outs, units: body.code.units, instructions: body.instructions, complete: body.complete, ...(body.error ? { error: body.error } : {}) } : body.error ? { complete: false, error: body.error } : null;
    const res: Record<string, unknown> = {
      sig: m.ref.sig,
      dex: ci!.code.name,
      access: methodAccessNames(m.accessFlags),
      kind: m.direct ? "direct" : "virtual",
      code,
      parameters: parametersOf(m, body),
      calls: callSummary(index, body),
      strings: unique(body.strings, 100).map((s) => (s.length > LIMITS.maxStringChars ? s.slice(0, LIMITS.maxStringChars) : s)),
      newInstances: unique(body.newInstances.map(descriptorToName), 100),
      unresolvedRefs: body.unresolvedRefs,
      ...callConstants(index, ci!, m, body),
    };
    // Without `depth` only the method itself is described; with it, the calls inside the app are followed too.
    if (o.depth !== undefined) {
      const visited = reach(index, [{ ci: ci!, m }], o.depth);
      const appMethods = visited.slice(1, 201).map((v) => ({ sig: v.def.m.ref.sig, depth: v.level - 1 }));
      const external = new Map<string, { callee: string; from: string }>();
      const strings: string[] = [];
      for (const v of visited) {
        strings.push(...v.body.strings);
        for (const c of v.body.calls) if (index.isExternal(c) && !external.has(c.ref.sig)) external.set(c.ref.sig, { callee: c.ref.sig, from: v.def.m.ref.sig });
      }
      res["transitive"] = {
        levels: o.depth,
        visitedMethods: visited.length,
        appMethods,
        externalCalls: [...external.values()].slice(0, 300),
        strings: unique(strings, 100).map((s) => (s.length > LIMITS.maxStringChars ? s.slice(0, LIMITS.maxStringChars) : s)),
        truncated: visited.length >= MAX_VISITED || visited.length - 1 > 200 || external.size > 300,
      };
    }
    return res;
  });
  return { class: o.cls, method: o.method, matches, ...(index.errors.length ? { dexErrors: index.errors } : {}) };
}

export function apkXrefs(apk: Apk, o: { method?: string | undefined; string?: string | undefined; limit: number }): object {
  const mNeedle = o.method?.toLowerCase();
  const sNeedle = o.string?.toLowerCase();
  if (!mNeedle && !sNeedle) throw new ApkError("give a method and/or string to search for");
  const index = CodeIndex.open(apk);
  const callers: { method: string; dex: string; hits: string[] }[] = [];
  let matched = 0;
  for (const ci of index.classes.values()) {
    for (const m of index.methodsOf(ci)) {
      if (m.codeOff === 0) continue;
      const body = index.body(ci, m, false);
      const hits: string[] = [];
      if (mNeedle) {
        for (const c of body.calls) {
          if (!c.ref.sig.toLowerCase().includes(mNeedle)) continue;
          const known = index.constants(ci, m, body).sites.get(c.unit);
          hits.push(`${c.opName} ${c.ref.sig}${known ? ` [${known.map(describeArg).join(", ")}]` : ""}`);
        }
      }
      if (sNeedle) for (const s of body.strings) if (s.toLowerCase().includes(sNeedle)) hits.push(`string "${s.length > 120 ? s.slice(0, 120) + "…" : s}"`);
      if (!hits.length) continue;
      matched++;
      if (callers.length < o.limit) callers.push({ method: m.ref.sig, dex: ci.code.name, hits: unique(hits, 10) });
    }
  }
  return { matchedCallers: matched, returned: callers.length, truncated: matched > callers.length, callers, ...(index.errors.length ? { dexErrors: index.errors } : {}) };
}

// ---- entry points of exported components --------------------------------

/** Framework methods whose job is to look at, or constrain, the caller. Matched by name on code that is not in the app. */
const CHECK_APIS = new Map<string, string>(Object.entries({
  getCallingUid: "uid",
  getCallingPid: "uid",
  getCallingUidOrThrow: "uid",
  getCallingUserHandle: "uid",
  checkCallingPermission: "permission",
  checkCallingOrSelfPermission: "permission",
  enforceCallingPermission: "permission",
  enforceCallingOrSelfPermission: "permission",
  checkCallingUriPermission: "permission",
  enforceCallingUriPermission: "permission",
  checkPermission: "permission",
  enforcePermission: "permission",
  getPackagesForUid: "package",
  getNameForUid: "package",
  getPackageUid: "package",
  getPackageInfo: "package",
  checkSignatures: "signature",
  hasSigningCertificate: "signature",
}));

const ENTRY_METHODS = new Map<string, string[]>(Object.entries({
  service: ["onBind", "onGetRoot", "onStartCommand", "onLoadChildren", "onLoadItem", "onSearch", "onCustomAction"],
  provider: ["query", "insert", "update", "delete", "call", "openFile", "openAssetFile"],
  receiver: ["onReceive"],
  activity: ["onCreate", "onNewIntent"],
}));

const PACKAGE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

const LIMIT_NOTES = [
  "Static reading of the bytecode: calls made through reflection, JNI or code loaded at runtime are not followed.",
  "Calls are resolved by name and prototype inside the app (superclasses, interfaces, classes the method itself instantiates). Framework and library code, including what runs before the entry point, is not analysed.",
  "A reachable caller-check API does not prove its result gates the operation, and none reachable does not prove the component safe: the check can sit in the framework, in the manifest permission, or deeper than the depth analysed.",
];

const UNKNOWN_NOTES = [
  "Whether the result of a check decides what the entry point returns or does (read the decompiled method: apk_decompile when jadx is enabled, or the source).",
  "Whether the manifest permission, if any, is strong enough (its protection level is defined where the permission is declared).",
];

export function apkEntrypointChecks(apk: Apk, o: { component?: string | undefined; depth: number }): object {
  const manifest = readManifest(apk);
  const index = CodeIndex.open(apk);
  const needle = o.component?.toLowerCase();
  const wanted = manifest.components.filter((c) => c.exported && !(c.kind === "activity" && c.launcher) && ENTRY_METHODS.has(c.kind) && (!needle || c.name.toLowerCase().includes(needle)));

  const components = wanted.map((c) => {
    const root = index.classes.get(descriptorOf(c.name));
    const names = ENTRY_METHODS.get(c.kind)!;
    const entries: Def[] = [];
    const seenKeys = new Set<string>();
    const seenClasses = new Set<string>();
    for (let d: string | null = root ? root.descriptor : null; d && !seenClasses.has(d); ) {
      seenClasses.add(d);
      const ci = index.classes.get(d);
      if (!ci) break;
      for (const m of index.methodsOf(ci)) {
        const key = `${m.ref.name}${m.ref.proto}`;
        if (names.includes(m.ref.name) && m.codeOff !== 0 && !seenKeys.has(key)) {
          seenKeys.add(key);
          entries.push({ ci, m });
        }
      }
      d = ci.superDescriptor;
    }

    const entryMethods = entries.map((e) => {
      const visited = reach(index, [e], o.depth);
      const checks = new Map<string, { api: string; category: string; via: string[] }>();
      const strings: string[] = [];
      for (const v of visited) {
        strings.push(...v.body.strings);
        for (const call of v.body.calls) {
          const category = CHECK_APIS.get(call.ref.name);
          if (category && index.isExternal(call) && !checks.has(call.ref.sig)) checks.set(call.ref.sig, { api: call.ref.sig, category, via: chainOf(v) });
        }
      }
      const params = parametersOf(e.m, visited[0]!.body);
      return {
        declaredIn: descriptorToName(e.ci.descriptor),
        name: e.m.ref.name,
        proto: e.m.ref.proto,
        sig: e.m.ref.sig,
        parameters: params,
        reachableAppMethods: visited.length,
        callerChecks: [...checks.values()],
        allowListCandidates: unique(strings.filter((s) => s.length <= 100 && PACKAGE_NAME.test(s) && !s.includes(".permission.")), 50),
        permissionStrings: unique(strings.filter((s) => s.length <= 150 && (/\.permission\./.test(s) || s.startsWith("android.permission."))), 50),
      };
    });

    const checkCount = entryMethods.reduce((n, m) => n + m.callerChecks.length, 0);
    const assessment = entryMethods.length === 0 ? "entry-point-not-found" : checkCount > 0 ? "caller-check-apis-observed" : "no-caller-check-observed";
    const observed: string[] = [];
    if (!root) observed.push(`The class ${c.name} is not in the dex files of this APK.`);
    else if (entryMethods.length === 0) observed.push(`No ${names.join("/")} method with code was found in ${c.name} or its superclasses defined in the app.`);
    for (const m of entryMethods) {
      observed.push(`${m.name} is declared in ${m.declaredIn}; ${m.reachableAppMethods} app method(s) reached within ${o.depth} level(s).`);
      if (m.callerChecks.length) for (const k of m.callerChecks) observed.push(`${k.category} check API ${k.api} is reached via ${k.via.map((x) => x.split("->")[1]!.split("(")[0]).join(" > ")}.`);
      else observed.push(`No caller-validation API (uid, permission, package or signature lookups) is reachable from ${m.name} through app code within ${o.depth} level(s).`);
      const unused = m.parameters.filter((p) => p.readCount === 0);
      if (m.parameters.length && unused.length === m.parameters.length) observed.push(`${m.name} never reads any of its ${m.parameters.length} parameter(s).`);
      else if (unused.length) observed.push(`${m.name} never reads parameter(s) ${unused.map((p) => `#${p.index} (${p.type})`).join(", ")}.`);
    }
    if (c.permission) observed.push(`The manifest requires permission ${c.permission}; Android enforces it before the entry point runs.`);
    const split = [c.readPermission ? `read permission ${c.readPermission}` : "", c.writePermission ? `write permission ${c.writePermission}` : ""].filter(Boolean);
    if (split.length) observed.push(`The manifest requires ${split.join(" and ")}; Android enforces them before the entry point runs.`);
    return { name: c.name, kind: c.kind, exported: true, permission: c.permission ?? null, readPermission: c.readPermission ?? null, writePermission: c.writePermission ?? null, found: root !== undefined, assessment, entryMethods, observed, unknown: UNKNOWN_NOTES };
  });

  return { depth: o.depth, components, limits: LIMIT_NOTES, ...(index.errors.length ? { dexErrors: index.errors } : {}) };
}
