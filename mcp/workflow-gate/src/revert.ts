import { randomUUID } from "node:crypto";
import { constants, copyFileSync, cpSync, lstatSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkCommand, DEFAULT_TIMEOUT_MS, runCommand, storedOutput } from "./exec.js";
import { addProof, checkRelative, commandFor, fixGone, gitOut, meets, repoState, stepOf, type Gate } from "./gate.js";
import { git } from "./git.js";
import { redact } from "./secrets.js";

export function defaultWorktreesDir(): string {
  return join(homedir(), ".proofbench", "gate-worktrees");
}

/** Every link in the path must be a real folder or file: no symlink followed, neither in the repo nor in the copy. */
function checkNoLink(root: string, path: string): void {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`copyFiles refused, symlink: ${JSON.stringify(path)}`);
  }
}

/** Redone after the control run's cleanup. The commit may have planted a link at that spot; COPYFILE_EXCL overwrites nothing. */
function copyInto(repo: string, copy: string, files: readonly string[], dirs: readonly string[]): void {
  for (const dir of dirs) {
    checkNoLink(copy, dir);
    // A real copy, not a junction: `git clean` and deleting the copy must not be able to traverse anything.
    cpSync(join(repo, dir), join(copy, dir), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  }
  for (const file of files) {
    checkNoLink(copy, file);
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    copyFileSync(join(repo, file), join(copy, file), constants.COPYFILE_EXCL);
  }
}

async function commitOf(repo: string, ref: string): Promise<string> {
  const r = await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (r.code !== 0) throw new Error(`Unknown commit: ${JSON.stringify(ref)}`);
  return r.stdout.trim();
}

/** The test file must be an ordinary file in the fix commit, not a link. */
async function checkBlob(repo: string, fix: string, path: string): Promise<void> {
  const tree = await gitOut(repo, ["ls-tree", "-z", fix, "--", `:(literal)${path}`]);
  if (!/^100(644|755) blob /.test(tree)) throw new Error(`testFile missing from the fix commit: ${JSON.stringify(path)}`);
}

/**
 * Proves that the test fails without the fix: a copy at the fix's parent, with only the fix's test file.
 * Then a control run: the same command, in the same copy, must pass at the fix commit. Without it, a
 * copy that cannot build itself would give a failure, hence a false proof.
 */
export async function revertFails(gate: Gate, input: { fixCommit: string; testFile: string; copyFiles: readonly string[]; copyDirs: readonly string[] }, timeoutMs: number = DEFAULT_TIMEOUT_MS, baseDir: string = defaultWorktreesDir()) {
  const step = stepOf(gate, "revert_fails");
  const command = commandFor(gate, step);
  if (!command) throw new Error("No test command given to gate_start");
  const testFile = checkRelative(input.testFile, "testFile");
  const copyFiles = input.copyFiles.map((f) => checkRelative(f, "copyFiles"));
  for (const file of copyFiles) {
    checkNoLink(gate.repo, file);
    if (!lstatSync(join(gate.repo, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`copyFiles: file missing: ${JSON.stringify(file)}`);
  }
  const copyDirs = input.copyDirs.map((d) => checkRelative(d, "copyDirs"));
  for (const dir of copyDirs) {
    checkNoLink(gate.repo, dir);
    if (!lstatSync(join(gate.repo, dir), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`copyDirs: folder missing: ${JSON.stringify(dir)}`);
  }
  const fix = await commitOf(gate.repo, input.fixCommit);
  const parent = await commitOf(gate.repo, `${fix}^1`);
  const state = await repoState(gate.repo, gate.watchIgnored);
  if (fix !== state.sha && (await git(gate.repo, ["merge-base", "--is-ancestor", fix, state.sha])).code !== 0) {
    throw new Error(`The fix ${fix} is not in HEAD's history`);
  }
  await checkBlob(gate.repo, fix, testFile);
  const gone = await fixGone(gate.repo, fix, testFile, state.sha);
  if (gone) throw new Error(`Fix missing from HEAD: ${gone}`);

  const parentDir = join(baseDir, gate.id.slice(0, 8));
  const copy = join(parentDir, randomUUID().slice(0, 8));
  mkdirSync(parentDir, { recursive: true });
  try {
    await gitOut(gate.repo, ["worktree", "add", "--detach", "--quiet", copy, parent]);
    await gitOut(copy, ["checkout", "--quiet", fix, "--", `:(literal)${testFile}`]);
    copyInto(gate.repo, copy, copyFiles, copyDirs);
    checkCommand(command, copy);
    const reverted = await runCommand(command, copy, timeoutMs);
    let controlExitCode: number | null | undefined;
    let failure = reverted.failure;
    if (reverted.exitCode !== null && reverted.exitCode !== 0) {
      await gitOut(copy, ["checkout", "--quiet", "--force", "--detach", fix]);
      await gitOut(copy, ["clean", "-fdxq"]);
      copyInto(gate.repo, copy, copyFiles, copyDirs);
      const control = await runCommand(command, copy, timeoutMs);
      controlExitCode = control.exitCode;
      if (control.exitCode !== 0) failure = `control: with the fix too, code ${String(control.exitCode)}`;
    }
    const proof = addProof(gate, step, state, {
      command,
      exitCode: reverted.exitCode,
      output: storedOutput(`${reverted.stdout}\n${reverted.stderr}`),
      fix,
      testFile,
      ...(failure ? { failure: redact(failure) } : {}),
    });
    return { step: step.id, exitCode: proof.exitCode, controlExitCode, ok: meets(step, proof), expected: step.expect, failure: proof.failure, fix, parent, testFile, output: proof.output };
  } finally {
    await git(gate.repo, ["worktree", "remove", "--force", copy]);
    rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await git(gate.repo, ["worktree", "prune"]);
    try {
      rmdirSync(parentDir);
    } catch {
      // another copy of the gate occupies it
    }
  }
}
