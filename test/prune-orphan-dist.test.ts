import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  planOrphanDistArtifacts,
  pruneOrphanDistArtifacts,
} from "../scripts/prune-orphan-dist.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const packageName = `fixture-${process.pid}-${Date.now()}-${roots.length}`;
  const packageRoot = path.join(import.meta.dirname, "..", "packages", packageName);
  roots.push(packageRoot);
  fs.mkdirSync(path.join(packageRoot, "src", "nested"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist", "nested"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist", "assets"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    scripts: { build: "tsc -p tsconfig.json" },
  }));

  for (const source of ["live.ts", "view.tsx", "nested/kept.ts"]) {
    fs.writeFileSync(path.join(packageRoot, "src", source), "export {};\n");
    const stem = source.replace(/\.(?:ts|tsx)$/, "");
    fs.writeFileSync(path.join(packageRoot, "dist", `${stem}.js`), "export {};\n");
    fs.writeFileSync(path.join(packageRoot, "dist", `${stem}.js.map`), "{}\n");
  }

  for (const relative of ["orphan.js", "orphan.js.map", "orphan.d.ts", "orphan.d.ts.map"]) {
    fs.writeFileSync(path.join(packageRoot, "dist", relative), "stale\n");
  }
  fs.writeFileSync(path.join(packageRoot, "dist", "assets", "runtime.json"), "{}\n");
  fs.writeFileSync(path.join(packageRoot, "dist", "ambient.d.ts"), "export {};\n");
  return packageRoot;
}

describe("orphaned dist pruning (#400)", () => {
  it("identifies only JavaScript with no TypeScript-family source twin", () => {
    const packageRoot = fixture();
    const plan = planOrphanDistArtifacts(packageRoot);

    expect(plan.orphans.map((entry) => path.basename(entry.entrypoint))).toEqual(["orphan.js"]);
    expect(plan.live.map((entry) => path.relative(plan.distRoot, entry)).sort()).toEqual([
      "live.js",
      "nested/kept.js",
      "view.js",
    ]);
  });

  it("removes an orphan and only its compiler siblings", () => {
    const packageRoot = fixture();
    pruneOrphanDistArtifacts(packageRoot);

    for (const relative of ["orphan.js", "orphan.js.map", "orphan.d.ts", "orphan.d.ts.map"]) {
      expect(fs.existsSync(path.join(packageRoot, "dist", relative))).toBe(false);
    }
    for (const relative of [
      "live.js",
      "live.js.map",
      "view.js",
      "assets/runtime.json",
      "ambient.d.ts",
    ]) {
      expect(fs.existsSync(path.join(packageRoot, "dist", relative))).toBe(true);
    }
  });

  it("refuses a plan that could empty dist and leaves the package runnable", () => {
    const packageRoot = fixture();
    fs.rmSync(path.join(packageRoot, "src"), { recursive: true, force: true });
    fs.mkdirSync(path.join(packageRoot, "src"));
    const entrypoint = path.join(packageRoot, "dist", "live.js");

    expect(() => pruneOrphanDistArtifacts(packageRoot)).toThrow(
      "every compiled JavaScript entrypoint appears orphaned",
    );
    expect(fs.existsSync(entrypoint)).toBe(true);
  });

  it("does not prune after a failed build", () => {
    const packageRoot = fixture();
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      scripts: {
        build: `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
        postbuild: "node ../../scripts/prune-orphan-dist.mjs --package .",
      },
    }));
    const orphan = path.join(packageRoot, "dist", "orphan.js");

    const result = spawnSync("npm", ["run", "build"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(7);
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it("refuses packages with another output owner instead of deleting copied JavaScript", () => {
    const packageRoot = fixture();
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      scripts: { build: "tsc -p tsconfig.json && node copy-generated.mjs" },
    }));
    const copied = path.join(packageRoot, "dist", "copied-runtime.js");
    fs.writeFileSync(copied, "export {};\n");

    expect(() => pruneOrphanDistArtifacts(packageRoot)).toThrow("build is not plain tsc");
    expect(fs.existsSync(copied)).toBe(true);
  });

  it("runs from every production package's postbuild, after tsc succeeds", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    for (const packageName of ["adapters", "core", "bridge"]) {
      const manifest = JSON.parse(fs.readFileSync(
        path.join(repoRoot, "packages", packageName, "package.json"),
        "utf8",
      )) as { scripts?: Record<string, string> };
      expect(manifest.scripts?.build).toBe("tsc -p tsconfig.json");
      expect(manifest.scripts?.postbuild).toBe(
        "node ../../scripts/prune-orphan-dist.mjs --package .",
      );
    }
  });
});
