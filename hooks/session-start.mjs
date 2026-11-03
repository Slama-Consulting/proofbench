// SessionStart (Claude Code): injects the router into the context so the right skill
// loads on the very first request, without the user ever naming it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let router;
try {
  router = readFileSync(join(root, "skills", "using-proofbench", "SKILL.md"), "utf8");
} catch {
  router = "Proofbench: the using-proofbench skill is missing. Reinstall the plugin.";
}

const additionalContext =
  "<IMPORTANT>\nProofbench is installed. For any development request, apply this router BEFORE answering. " +
  "Load the other skills with the Skill tool under the name `proofbench:<skill>`.\n\n" +
  router +
  "\n</IMPORTANT>";

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
