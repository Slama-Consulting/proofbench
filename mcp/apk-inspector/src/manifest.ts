import { decodeAxml, type XmlNode } from "./axml.js";
import type { Apk } from "./apk.js";

const DANGEROUS = new Set([
  "READ_CALENDAR", "WRITE_CALENDAR", "CAMERA", "READ_CONTACTS", "WRITE_CONTACTS", "GET_ACCOUNTS",
  "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "RECORD_AUDIO",
  "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "ANSWER_PHONE_CALLS", "READ_CALL_LOG",
  "WRITE_CALL_LOG", "ADD_VOICEMAIL", "USE_SIP", "PROCESS_OUTGOING_CALLS", "BODY_SENSORS",
  "BODY_SENSORS_BACKGROUND", "ACTIVITY_RECOGNITION", "SEND_SMS", "RECEIVE_SMS", "READ_SMS",
  "RECEIVE_WAP_PUSH", "RECEIVE_MMS", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE",
  "ACCESS_MEDIA_LOCATION", "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO",
  "READ_MEDIA_VISUAL_USER_SELECTED", "POST_NOTIFICATIONS", "NEARBY_WIFI_DEVICES", "BLUETOOTH_CONNECT",
  "BLUETOOTH_SCAN", "BLUETOOTH_ADVERTISE", "UWB_RANGING",
]);

/** Not "dangerous" in the runtime-permission sense, but high-impact and worth a second look. */
const SPECIAL = new Set([
  "SYSTEM_ALERT_WINDOW", "REQUEST_INSTALL_PACKAGES", "MANAGE_EXTERNAL_STORAGE", "QUERY_ALL_PACKAGES",
  "BIND_ACCESSIBILITY_SERVICE", "BIND_DEVICE_ADMIN", "WRITE_SETTINGS", "REQUEST_DELETE_PACKAGES",
  "USE_FULL_SCREEN_INTENT", "SCHEDULE_EXACT_ALARM", "USE_EXACT_ALARM", "READ_LOGS", "INSTALL_PACKAGES",
  "BIND_NOTIFICATION_LISTENER_SERVICE", "RECEIVE_BOOT_COMPLETED", "FOREGROUND_SERVICE_SPECIAL_USE",
]);

export type PermissionRisk = "dangerous" | "special" | "normal";

export function permissionRisk(name: string): PermissionRisk {
  const short = name.startsWith("android.permission.") ? name.slice("android.permission.".length) : name === "com.android.voicemail.permission.ADD_VOICEMAIL" ? "ADD_VOICEMAIL" : null;
  if (short === null) return "normal";
  if (DANGEROUS.has(short)) return "dangerous";
  if (SPECIAL.has(short)) return "special";
  return "normal";
}

type Val = string | number | boolean | undefined;

export interface IntentFilter {
  actions: string[];
  categories: string[];
  data: { scheme?: string; host?: string; port?: string; path?: string; pathPrefix?: string; pathPattern?: string; mimeType?: string }[];
  autoVerify?: boolean;
  priority?: number;
}

export interface Component {
  kind: "activity" | "activity-alias" | "service" | "receiver" | "provider";
  name: string;
  exported: boolean;
  exportedSource: "explicit" | "implied" | "default";
  enabled?: boolean;
  permission?: string;
  readPermission?: string;
  writePermission?: string;
  authorities?: string;
  grantUriPermissions?: boolean;
  targetActivity?: string;
  process?: string;
  launcher?: boolean;
  intentFilters: IntentFilter[];
}

export interface ManifestInfo {
  package: string | null;
  versionName: string | number | null;
  versionCode: number | null;
  sdk: { min: number | string | null; target: number | string | null; max: number | string | null; compile: number | string | null };
  sharedUserId: string | null;
  permissions: { name: string; risk: PermissionRisk; maxSdkVersion?: number }[];
  customPermissions: { name: string; protectionLevel?: string | number }[];
  features: { name?: string; glEsVersion?: string; required: boolean }[];
  application: {
    name: string | null;
    flags: Record<string, string | number | boolean>;
    debuggable: boolean;
    allowBackup: boolean;
    allowBackupSource: "explicit" | "default";
    usesCleartextTraffic: boolean | null;
    networkSecurityConfig: string | null;
  };
  components: Component[];
  /** Plain-language notes on settings that deserve review. These are leads, not verdicts. */
  auditFlags: string[];
  /** Reference text (e.g. `@0x7f0e001a`) is returned as is: resources.arsc is not decoded. */
  resourceReferencesResolved: false;
}

const str = (v: Val): string | undefined => (v === undefined ? undefined : String(v));
const bool = (v: Val): boolean | undefined => (typeof v === "boolean" ? v : v === undefined ? undefined : v === "true" || v === 1 ? true : v === "false" || v === 0 ? false : undefined);
const num = (v: Val): number | undefined => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

function qualify(pkg: string | null, name: string | undefined): string {
  if (!name) return "";
  if (!pkg) return name;
  if (name.startsWith(".")) return pkg + name;
  if (!name.includes(".")) return pkg + "." + name;
  return name;
}

function filterOf(f: XmlNode): IntentFilter {
  const out: IntentFilter = { actions: [], categories: [], data: [] };
  for (const c of f.children) {
    if (c.name === "action") out.actions.push(String(c.attrs["android:name"] ?? ""));
    else if (c.name === "category") out.categories.push(String(c.attrs["android:name"] ?? ""));
    else if (c.name === "data") {
      const d: IntentFilter["data"][number] = {};
      for (const k of ["scheme", "host", "port", "path", "pathPrefix", "pathPattern", "mimeType"] as const) {
        const v = c.attrs[`android:${k}`];
        if (v !== undefined) d[k] = String(v);
      }
      out.data.push(d);
    }
  }
  const av = bool(f.attrs["android:autoVerify"]);
  if (av !== undefined) out.autoVerify = av;
  const pr = num(f.attrs["android:priority"]);
  if (pr !== undefined) out.priority = pr;
  return out;
}

const APP_FLAGS = [
  "debuggable", "allowBackup", "usesCleartextTraffic", "networkSecurityConfig", "requestLegacyExternalStorage",
  "extractNativeLibs", "hasCode", "testOnly", "largeHeap", "fullBackupContent", "dataExtractionRules",
  "persistent", "allowClearUserData", "supportsRtl", "hardwareAccelerated", "usesNonSdkApi", "isGame",
  "allowNativeHeapPointerTagging", "preserveLegacyExternalStorage",
] as const;

export function interpretManifest(root: XmlNode): ManifestInfo {
  const pkg = str(root.attrs["package"]) ?? null;
  const usesSdk = root.children.find((c) => c.name === "uses-sdk");
  const minV = usesSdk?.attrs["android:minSdkVersion"];
  const tgtV = usesSdk?.attrs["android:targetSdkVersion"];
  const maxV = usesSdk?.attrs["android:maxSdkVersion"];
  const compileV = root.attrs["android:compileSdkVersion"] ?? root.attrs["compileSdkVersion"];
  const tgtN = num(tgtV) ?? num(minV) ?? 1;

  const permissions: ManifestInfo["permissions"] = [];
  const customPermissions: ManifestInfo["customPermissions"] = [];
  const features: ManifestInfo["features"] = [];
  for (const c of root.children) {
    if (c.name === "uses-permission" || c.name === "uses-permission-sdk-23" || c.name === "uses-permission-sdk-m") {
      const name = str(c.attrs["android:name"]);
      if (!name) continue;
      const p: ManifestInfo["permissions"][number] = { name, risk: permissionRisk(name) };
      const mx = num(c.attrs["android:maxSdkVersion"]);
      if (mx !== undefined) p.maxSdkVersion = mx;
      permissions.push(p);
    } else if (c.name === "permission") {
      const name = str(c.attrs["android:name"]);
      if (name) {
        const pl = c.attrs["android:protectionLevel"];
        customPermissions.push(pl === undefined ? { name } : { name, protectionLevel: typeof pl === "boolean" ? String(pl) : pl });
      }
    } else if (c.name === "uses-feature") {
      const f: ManifestInfo["features"][number] = { required: bool(c.attrs["android:required"]) ?? true };
      const n = str(c.attrs["android:name"]);
      if (n) f.name = n;
      const gl = c.attrs["android:glEsVersion"];
      if (gl !== undefined) f.glEsVersion = typeof gl === "number" ? "0x" + gl.toString(16) : String(gl);
      features.push(f);
    }
  }

  const app = root.children.find((c) => c.name === "application");
  const flags: Record<string, string | number | boolean> = {};
  if (app) for (const k of APP_FLAGS) if (app.attrs[`android:${k}`] !== undefined) flags[k] = app.attrs[`android:${k}`]!;
  const abExplicit = bool(app?.attrs["android:allowBackup"]);
  const debuggable = bool(app?.attrs["android:debuggable"]) ?? false;
  const cleartext = bool(app?.attrs["android:usesCleartextTraffic"]) ?? null;
  const nsc = app?.attrs["android:networkSecurityConfig"];

  const components: Component[] = [];
  if (app) {
    for (const c of app.children) {
      if (!["activity", "activity-alias", "service", "receiver", "provider"].includes(c.name)) continue;
      const kind = c.name as Component["kind"];
      const filters = c.children.filter((x) => x.name === "intent-filter").map(filterOf);
      const explicit = bool(c.attrs["android:exported"]);
      let exported: boolean;
      let source: Component["exportedSource"];
      if (explicit !== undefined) {
        exported = explicit;
        source = "explicit";
      } else if (filters.length > 0 && tgtN < 31) {
        exported = true;
        source = "implied";
      } else if (kind === "provider" && tgtN < 17) {
        exported = true;
        source = "default";
      } else {
        exported = false;
        source = "default";
      }
      const comp: Component = { kind, name: qualify(pkg, str(c.attrs["android:name"])), exported, exportedSource: source, intentFilters: filters };
      const en = bool(c.attrs["android:enabled"]);
      if (en !== undefined) comp.enabled = en;
      for (const k of ["permission", "readPermission", "writePermission", "authorities", "process"] as const) {
        const v = str(c.attrs[`android:${k}`]);
        if (v !== undefined) comp[k] = v;
      }
      const gup = bool(c.attrs["android:grantUriPermissions"]);
      if (gup !== undefined) comp.grantUriPermissions = gup;
      if (kind === "activity-alias") {
        const t = str(c.attrs["android:targetActivity"]);
        if (t) comp.targetActivity = qualify(pkg, t);
      }
      if (filters.some((f) => f.actions.includes("android.intent.action.MAIN") && f.categories.includes("android.intent.category.LAUNCHER"))) comp.launcher = true;
      components.push(comp);
    }
  }

  const audit: string[] = [];
  if (debuggable) audit.push("android:debuggable is true: the app can be attached to and inspected on any device.");
  if (abExplicit === undefined) audit.push("android:allowBackup is not set (defaults to true): app data can be extracted with adb backup on older Android versions.");
  else if (abExplicit) audit.push("android:allowBackup is true: app data may be extracted with adb backup.");
  if (cleartext === true) audit.push("android:usesCleartextTraffic is true: plain HTTP is allowed.");
  if (bool(app?.attrs["android:testOnly"])) audit.push("android:testOnly is true.");
  if (bool(app?.attrs["android:requestLegacyExternalStorage"])) audit.push("requestLegacyExternalStorage is true: legacy broad storage access requested.");
  for (const c of components) {
    if (c.exported && !c.permission && !(c.kind === "activity" && c.launcher)) {
      const extra = c.kind === "provider" && !c.readPermission && !c.writePermission ? " with no read/write permission" : "";
      audit.push(`${c.kind} ${c.name} is exported (${c.exportedSource})${c.permission ? "" : " without a permission"}${extra}.`);
    }
  }
  for (const p of permissions) if (p.risk === "special") audit.push(`high-impact permission requested: ${p.name}`);

  const vc = root.attrs["android:versionCode"];
  const vn = root.attrs["android:versionName"];
  const app0 = app;
  return {
    package: pkg,
    versionName: vn === undefined || typeof vn === "boolean" ? null : vn,
    versionCode: num(vc) ?? null,
    sdk: {
      min: typeof minV === "boolean" ? null : (minV ?? null),
      target: typeof tgtV === "boolean" ? null : (tgtV ?? null),
      max: typeof maxV === "boolean" ? null : (maxV ?? null),
      compile: typeof compileV === "boolean" ? null : (compileV ?? null),
    },
    sharedUserId: str(root.attrs["android:sharedUserId"]) ?? null,
    permissions,
    customPermissions,
    features,
    application: {
      name: str(app0?.attrs["android:name"]) ?? null,
      flags,
      debuggable,
      allowBackup: abExplicit ?? true,
      allowBackupSource: abExplicit === undefined ? "default" : "explicit",
      usesCleartextTraffic: cleartext,
      networkSecurityConfig: nsc === undefined ? null : String(nsc),
    },
    components,
    auditFlags: audit,
    resourceReferencesResolved: false,
  };
}

export function readManifest(apk: Apk): ManifestInfo {
  return interpretManifest(decodeAxml(apk.readEntry("AndroidManifest.xml")));
}
