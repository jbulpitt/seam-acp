#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repoRoot, "packages");
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? walkFiles(path.join(root, entry.name))
      : [path.join(root, entry.name)]);
}

function assertPackageRoot(packageRoot) {
  const resolved = path.resolve(packageRoot);
  if (path.dirname(resolved) !== packagesRoot) {
    throw new Error(`refusing dist prune outside ${packagesRoot}: ${resolved}`);
  }
  for (const required of ["package.json", "src", "dist"]) {
    if (!fs.existsSync(path.join(resolved, required))) {
      throw new Error(`refusing dist prune: ${resolved} has no ${required}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8"));
  if (manifest.scripts?.build !== "tsc -p tsconfig.json") {
    // A package with a copy/generation step may legitimately own JavaScript
    // without a source twin. Refuse only this cleanup/build; the already-built
    // dist and the running host keep serving until the rule is updated (#400).
    throw new Error(
      `refusing dist prune for ${resolved}: build is not plain tsc -p tsconfig.json`,
    );
  }
  return resolved;
}

function sourceTwinExists(srcRoot, relativeStem) {
  return SOURCE_EXTENSIONS.some((extension) =>
    fs.existsSync(path.join(srcRoot, `${relativeStem}${extension}`)));
}

/**
 * Plan from JavaScript entrypoints only. TypeScript's companion files are
 * removed only when their owning .js has no source twin; standalone assets or
 * declarations are never inferred to be stale. `.tsx` is recognized even
 * though today's package includes contain only `.ts`; `.mts`/`.cts` emit
 * `.mjs`/`.cjs`, which this deliberately narrow cleanup never enumerates.
 */
export function planOrphanDistArtifacts(packageRoot) {
  const root = assertPackageRoot(packageRoot);
  const srcRoot = path.join(root, "src");
  const distRoot = path.join(root, "dist");
  const javascript = walkFiles(distRoot).filter((file) => file.endsWith(".js"));
  const live = [];
  const orphans = [];

  for (const entrypoint of javascript) {
    const relative = path.relative(distRoot, entrypoint);
    const stem = relative.slice(0, -".js".length);
    if (sourceTwinExists(srcRoot, stem)) {
      live.push(entrypoint);
      continue;
    }
    const base = entrypoint.slice(0, -".js".length);
    const files = [
      entrypoint,
      `${entrypoint}.map`,
      `${base}.d.ts`,
      `${base}.d.ts.map`,
    ].filter((file) => fs.existsSync(file));
    orphans.push({ entrypoint, files });
  }

  // A wrong package/source root could otherwise turn a verification cleanup
  // into an outage. Refuse this package only; its existing dist and every
  // other workspace package remain untouched and runnable (#400).
  if (javascript.length > 0 && live.length === 0 && orphans.length > 0) {
    throw new Error(
      `refusing dist prune for ${root}: every compiled JavaScript entrypoint appears orphaned`,
    );
  }

  return { packageRoot: root, distRoot, live, orphans };
}

export function pruneOrphanDistArtifacts(packageRoot) {
  const plan = planOrphanDistArtifacts(packageRoot);
  for (const orphan of plan.orphans) {
    for (const file of orphan.files) fs.unlinkSync(file);
  }
  return plan;
}

function workspacePackageRoots() {
  return fs.readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesRoot, entry.name))
    .filter((root) => fs.existsSync(path.join(root, "src")) && fs.existsSync(path.join(root, "dist")));
}

function relativeToRepo(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function main(argv) {
  const check = argv.includes("--check");
  const packageAt = argv.indexOf("--package");
  if (packageAt !== -1 && (!argv[packageAt + 1] || argv[packageAt + 1].startsWith("--"))) {
    throw new Error("--package requires a package directory");
  }
  const roots = packageAt === -1
    ? workspacePackageRoots()
    : [path.resolve(process.cwd(), argv[packageAt + 1] ?? "")];
  const plans = roots.map((root) => check
    ? planOrphanDistArtifacts(root)
    : pruneOrphanDistArtifacts(root));
  const orphans = plans.flatMap((plan) => plan.orphans);

  if (orphans.length === 0) {
    console.log("dist orphan check: clean");
    return;
  }
  const verb = check ? "found" : "pruned";
  console.log(`${verb} ${orphans.length} orphaned JavaScript artifact(s):`);
  for (const orphan of orphans) console.log(`- ${relativeToRepo(orphan.entrypoint)}`);
  if (check) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
