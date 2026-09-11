#!/usr/bin/env node
// Explicit maintenance command: SQL is read-only, dry-run is the default,
// and the canonical delivery resolver is the only deletion authority.
import Database from "better-sqlite3";
import path from "node:path";
import { parseArgs } from "node:util";
import { bindDoneDeliveryResolver, pruneDoneArtifacts } from "../packages/core/dist/core/dispatch/done-retention.js";
import * as delivery from "../packages/core/dist/core/dispatch/done-reconcile.js";

const { values } = parseArgs({ options: {
  "data-dir": { type: "string" },
  "dry-run": { type: "boolean" },
  apply: { type: "boolean" },
} });
if (!values["data-dir"] || (values.apply && values["dry-run"])) {
  throw new Error("usage: prune-dispatch-done.mjs --data-dir <directory> [--dry-run | --apply]");
}
if (typeof delivery.isDoneDeliveryResolved !== "function") {
  throw new Error("requires the #305 canonical delivery-resolution build; no artifacts changed");
}
const dataDir = path.resolve(values["data-dir"]);
const db = new Database(path.join(dataDir, "seam.db"), { readonly: true, fileMustExist: true });
try {
  // A pre-migration dry-run must keep legacy uncertainty rather than mutate
  // production schema just to inspect its backlog.
  const columns = db.prepare("PRAGMA table_info(delegation_log)").all();
  const reason = columns.some(column => column.name === "terminal_reason") ? "terminal_reason" : "NULL";
  const fields = `id,status,kind,correlation_id AS correlationId,target_ref AS targetRef,
    updated_utc AS updatedUtc,${reason} AS terminalReason`;
  const byId = db.prepare(`SELECT ${fields} FROM delegation_log WHERE id=?`);
  const byCorrelation = db.prepare(`SELECT ${fields} FROM delegation_log
    WHERE kind='report_back' AND correlation_id=? ORDER BY created_utc ASC,rowid ASC LIMIT 1`);
  // Reports contain counts/ids and error codes only; never private JSON parser
  // snippets, prompts, output, environment or host paths.
  const logger = { warn: (fields, message) => {
    process.stderr.write(JSON.stringify({ message, id: fields.id, code: fields.err?.code ?? "RETAINED" }) + "\n");
  } };
  const deps = bindDoneDeliveryResolver({ dataDir, logger,
    getDelegation: id => byId.get(id) ?? null,
    getReportBackByCorrelation: correlation => byCorrelation.get(correlation) ?? null,
    resolveDelivery: delivery.isDoneDeliveryResolved,
  });
  const summary = await pruneDoneArtifacts(deps, { dryRun: !values.apply });
  process.stdout.write(JSON.stringify(summary) + "\n");
  if (summary.failed) process.exitCode = 1;
} finally { db.close(); }
