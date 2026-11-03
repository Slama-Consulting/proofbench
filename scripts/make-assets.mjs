// Generates the README visuals (SVG, no external font, readable on light or dark backgrounds).
//   node scripts/make-assets.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
mkdirSync(out, { recursive: true });

const C = { bg: "#0d1117", panel: "#161b22", line: "#30363d", text: "#e6edf3", mute: "#8b949e",
  blue: "#58a6ff", green: "#3fb950", amber: "#d29922", purple: "#a371f7", red: "#f85149", teal: "#39c5cf", pink: "#db61a2" };
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const t = (x, y, s, { size = 16, fill = C.text, weight = 400, font = SANS, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const svg = (w, h, title, desc, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">` +
  `<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>` +
  `<rect width="${w}" height="${h}" rx="18" fill="${C.bg}"/>${body}</svg>\n`;
const write = (name, s) => writeFileSync(join(out, name), s);

const SKILLS = [
  { n: "regression-trace", c: C.blue, say: ["analyze this bug", "since when does it crash?", "which commit broke this?"], mcp: "regression-tracer", does: "Finds the culprit commit, bisects, proven verdict" },
  { n: "fix-bug", c: C.red, say: ["fix this bug", "apply the fix"], mcp: "workflow-gate", does: "Fix on a branch, test fails then passes" },
  { n: "build-feature", c: C.green, say: ["add this feature", "implement this"], mcp: "workflow-gate", does: "Need, plan, test first, code, proofs" },
  { n: "clean-up", c: C.amber, say: ["clean up this module", "remove dead code"], mcp: "workflow-gate", does: "Tidy-up without changing behaviour" },
  { n: "security-audit", c: C.purple, say: ["secure the app", "any secrets in the repo?"], mcp: "workflow-gate", does: "Secrets, Android manifest, staging API" },
  { n: "analyze-apk", c: C.teal, say: ["analyze this APK", "reverse engineering"], mcp: "apk-inspector", does: "Manifest, signature, classes, strings, leads" },
  { n: "read-ticket", c: C.pink, say: ["look at this ticket", "what is PROJ-123 about?"], mcp: "ticket-reader", does: "Jira, GitHub, GitLab, Linear: summary and next step" },
];

// ---------- hero ----------
{
  const W = 1280, H = 380;
  let b = "";
  b += t(64, 112, "Proofbench", { size: 68, weight: 800 });
  b += t(64, 160, "Your AI coding agent, with a method.", { size: 28, fill: C.blue, weight: 600 });
  b += t(64, 200, "Agent Skills + MCP servers that trigger on their own.", { size: 20, fill: C.mute });
  b += t(64, 228, "Claude Code · GitHub Copilot · Codex · Cursor · Gemini CLI", { size: 17, fill: C.mute });
  let x = 64, y = 276;
  for (const s of SKILLS) {
    const w = s.n.length * 9.4 + 28;
    if (x + w > 700) { x = 64; y += 44; }
    b += `<rect x="${x}" y="${y}" width="${w}" height="32" rx="16" fill="${s.c}" fill-opacity="0.16" stroke="${s.c}" stroke-opacity="0.7"/>`;
    b += t(x + w / 2, y + 21, s.n, { size: 14, fill: s.c, weight: 600, font: MONO, anchor: "middle" });
    x += w + 10;
  }
  b += `<rect x="740" y="48" width="476" height="284" rx="12" fill="${C.panel}" stroke="${C.line}"/>`;
  b += `<circle cx="764" cy="72" r="6" fill="${C.red}"/><circle cx="784" cy="72" r="6" fill="${C.amber}"/><circle cx="804" cy="72" r="6" fill="${C.green}"/>`;
  const lines = [["analyze this bug", "regression-trace", C.blue], ["clean up this module", "clean-up", C.amber], ["analyze this APK", "analyze-apk", C.teal], ["look at PROJ-482", "read-ticket", C.pink]];
  let ly = 116;
  for (const [say, skill, col] of lines) {
    b += t(768, ly, "›", { size: 17, fill: C.mute, font: MONO }) + t(790, ly, say, { size: 17, font: MONO });
    b += t(790, ly + 24, `skill loaded: ${skill}`, { size: 14, fill: col, font: MONO });
    ly += 52;
  }
  write("hero.svg", svg(W, H, "Proofbench: Agent Skills and MCP servers for AI coding agents", "Skills and MCP servers that make an AI coding agent analyze bugs, trace regressions, fix, build, clean up, secure, reverse-engineer APKs and read tickets.", b));
}

// ---------- how it works ----------
{
  const W = 1200, H = 430;
  const steps = [
    ["1  You ask", "\"analyze this bug\"", C.text],
    ["2  The router", "using-proofbench", C.blue],
    ["3  A skill", "regression-trace", C.green],
    ["4  An MCP server", "regression-tracer", C.amber],
    ["5  A report", "proven, sourced", C.purple],
  ];
  const bw = 196, gap = 30, x0 = (W - (steps.length * bw + (steps.length - 1) * gap)) / 2;
  let b = t(W / 2, 52, "From one sentence to a proven result", { size: 26, weight: 700, anchor: "middle" });
  steps.forEach(([h, s, col], i) => {
    const x = x0 + i * (bw + gap);
    b += `<rect x="${x}" y="100" width="${bw}" height="120" rx="12" fill="${C.panel}" stroke="${col}" stroke-opacity="0.8"/>`;
    b += t(x + bw / 2, 148, h, { size: 16, weight: 700, fill: col, anchor: "middle" });
    b += t(x + bw / 2, 184, s, { size: 15, font: MONO, anchor: "middle" });
    if (i < steps.length - 1) b += `<path d="M${x + bw + 6} 160 H${x + bw + gap - 8}" stroke="${C.mute}" stroke-width="2"/><path d="M${x + bw + gap - 14} 154 L${x + bw + gap - 6} 160 L${x + bw + gap - 14} 166" fill="none" stroke="${C.mute}" stroke-width="2"/>`;
  });
  const notes = [
    ["Automatic", "The router is injected at session start (Claude Code hook)\nor read from AGENTS.md, copilot-instructions.md, GEMINI.md."],
    ["Proven", "The server runs the commands itself and computes the score\nfrom the evidence. The agent does not grade itself."],
    ["Safe", "Logs, tickets, APKs and commits are data, never orders.\nEvery external write asks for your approval."],
  ];
  notes.forEach(([h, body], i) => {
    const x = 60 + i * 370;
    b += `<rect x="${x}" y="266" width="350" height="124" rx="12" fill="${C.panel}" stroke="${C.line}"/>`;
    b += t(x + 20, 298, h, { size: 17, weight: 700 });
    body.split("\n").forEach((l, k) => { b += t(x + 20, 326 + k * 22, l, { size: 14, fill: C.mute }); });
  });
  write("how-it-works.svg", svg(W, H, "How Proofbench works", "You ask, the router picks a skill, the skill drives an MCP server, the server produces a proof-backed report.", b));
}

// ---------- skills map ----------
{
  const W = 1200, cw = 276, ch = 196, gx = 20, gy = 20;
  const rows = 2, H = 110 + rows * ch + (rows - 1) * gy + 40;
  let b = t(W / 2, 52, "Seven skills, one sentence to trigger them", { size: 26, weight: 700, anchor: "middle" });
  b += t(W / 2, 80, "You never have to name the skill.", { size: 15, fill: C.mute, anchor: "middle" });
  SKILLS.forEach((s, i) => {
    const r = Math.floor(i / 4), c = i % 4;
    const n = r === 0 ? 4 : 3;
    const rowW = n * cw + (n - 1) * gx;
    const x = (W - rowW) / 2 + c * (cw + gx), y = 110 + r * (ch + gy);
    b += `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="12" fill="${C.panel}" stroke="${C.line}"/>`;
    b += `<rect x="${x}" y="${y}" width="6" height="${ch}" rx="3" fill="${s.c}"/>`;
    b += t(x + 22, y + 34, s.n, { size: 18, weight: 700, fill: s.c, font: MONO });
    s.say.slice(0, 3).forEach((q, k) => { b += t(x + 22, y + 66 + k * 22, `"${q}"`, { size: 14 }); });
    const words = s.does.split(" "), rowsTxt = [""];
    for (const w of words) { const cur = rowsTxt[rowsTxt.length - 1]; if ((cur + " " + w).trim().length > 34) rowsTxt.push(w); else rowsTxt[rowsTxt.length - 1] = (cur + " " + w).trim(); }
    rowsTxt.slice(0, 2).forEach((l, k) => { b += t(x + 22, y + 138 + k * 17, l, { size: 12.5, fill: C.mute }); });
    b += t(x + 22, y + 182, `MCP: ${s.mcp}`, { size: 12.5, fill: C.mute, font: MONO });
  });
  write("skills.svg", svg(W, H, "The seven Proofbench skills", "regression-trace, fix-bug, build-feature, clean-up, security-audit, analyze-apk and read-ticket, with their trigger phrases.", b));
}

// ---------- compatibility ----------
{
  const W = 1200, H = 250;
  const items = [["Claude Code", "plugin + hook", C.amber], ["GitHub Copilot", "skills + VS Code MCP", C.blue], ["Codex", "skills + config.toml", C.green], ["Cursor", "rule + MCP", C.purple], ["Gemini CLI", "extension + GEMINI.md", C.teal]];
  let b = t(W / 2, 50, "One repository, five assistants", { size: 26, weight: 700, anchor: "middle" });
  const bw = 200, gap = 18, x0 = (W - (items.length * bw + (items.length - 1) * gap)) / 2;
  items.forEach(([n, how, col], i) => {
    const x = x0 + i * (bw + gap);
    b += `<rect x="${x}" y="86" width="${bw}" height="110" rx="12" fill="${C.panel}" stroke="${col}" stroke-opacity="0.8"/>`;
    b += t(x + bw / 2, 128, n, { size: 18, weight: 700, fill: col, anchor: "middle" });
    b += t(x + bw / 2, 160, how, { size: 13, fill: C.mute, anchor: "middle" });
  });
  b += t(W / 2, 226, "Agent Skills format (SKILL.md) + stdio MCP servers: the two standards these assistants read.", { size: 13, fill: C.mute, anchor: "middle" });
  write("platforms.svg", svg(W, H, "Compatible AI coding assistants", "Claude Code, GitHub Copilot, Codex, Cursor and Gemini CLI.", b));
}

// ---------- social preview (GitHub: Settings > Social preview; convert to PNG 1280x640 before upload) ----------
{
  const W = 1280, H = 640;
  let b = t(W / 2, 200, "Proofbench", { size: 110, weight: 800, anchor: "middle" });
  b += t(W / 2, 270, "Agent Skills + MCP servers for AI coding agents", { size: 38, fill: C.blue, weight: 600, anchor: "middle" });
  b += t(W / 2, 330, "Bug analysis · regression tracing · fixes · security audit · APK reverse engineering · tickets", { size: 24, fill: C.mute, anchor: "middle" });
  b += t(W / 2, 388, "Claude Code · GitHub Copilot · Codex · Cursor · Gemini CLI", { size: 24, fill: C.text, anchor: "middle" });
  const widths = SKILLS.map((s) => s.n.length * 10.6 + 30);
  let x = (W - (widths.reduce((a, v) => a + v, 0) + 12 * (SKILLS.length - 1))) / 2;
  for (const [i, s] of SKILLS.entries()) {
    const w = widths[i];
    b += `<rect x="${x}" y="470" width="${w}" height="38" rx="19" fill="${s.c}" fill-opacity="0.16" stroke="${s.c}" stroke-opacity="0.7"/>`;
    b += t(x + w / 2, 495, s.n, { size: 16, fill: s.c, weight: 600, font: MONO, anchor: "middle" });
    x += w + 12;
  }
  write("social-preview.svg", svg(W, H, "Proofbench", "Agent Skills and MCP servers for AI coding agents.", b));
}

console.log("assets/: hero.svg, how-it-works.svg, skills.svg, platforms.svg, social-preview.svg");
