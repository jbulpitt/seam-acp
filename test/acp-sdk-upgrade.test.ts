import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.dirname(fileURLToPath(import.meta.url));

describe("ACP SDK upgrade contracts", () => {
  for (const fixture of ["routed-closure", "v2-extensible-unions"]) {
    it(`typechecks ${fixture}`, () => {
      const program = ts.createProgram([path.join(root, "fixtures", `acp-sdk-${fixture}.ts`)], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ({
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      }));
      expect(diagnostics).toEqual([]);
    });
  }
});
