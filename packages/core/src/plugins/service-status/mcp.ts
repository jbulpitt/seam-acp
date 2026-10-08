import type { McpContribution } from "../mcp-registry.js";
import type { ServiceStatusMcpView, ServiceStatusReadOptions, ServiceStatusRefreshOptions } from "../../core/service-status/mcp-view.js";
import { invalidArgumentError } from "../../lib/invalid-argument.js";

const descriptors = [
{
    name: "service_status",
    description:
      "Read the cached upstream status of the registered services Seam depends on. Cache only — this tool performs " +
      "no network work and returns immediately. Each source reports `reportedStatus` (what the provider " +
      "said) separately from `observation.health` (whether Seam can currently reach it), so a stale or " +
      "failing poll is never mistaken for a provider outage. Use this first when an agent call fails and " +
      "you suspect an upstream problem; use service_status_refresh only if the cached data is too old.",
    inputSchema: {
      type: "object",
      properties: {
        sourceIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional registered source ids. Omit for every source. Unknown ids are rejected; " +
            "no URL or credential can be supplied.",
        },
        includeComponents: {
          type: "boolean",
          description: "Include per-component detail, worst status first. Default false.",
        },
        includeAllComponents: {
          type: "boolean",
          description:
            "Include components outside the configured relevant selection. Default false.",
        },
        includeIncidents: {
          type: "boolean",
          description: "Include active incidents. Default true.",
        },
        includeResolvedIncidents: {
          type: "boolean",
          description: "Also include recently resolved incidents still in retention. Default false.",
        },
        includeHistory: {
          type: "boolean",
          description: "Include recent material transitions for each source. Default false.",
        },
        componentLimit: { type: "number", minimum: 1, maximum: 50 },
        incidentLimit: { type: "number", minimum: 1, maximum: 25 },
        updateLimit: {
          type: "number",
          minimum: 1,
          maximum: 20,
          description: "Advisory updates returned per incident, newest first.",
        },
        historyLimit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: [],
    },
  },
  {
    name: "service_status_refresh",
    description:
      "Force a bounded live refresh of the registered service-status sources and WAIT for the result, " +
      "so the returned data reflects fresh upstream attempts rather than the cached snapshot. Only " +
      "registered source ids are accepted. Concurrent callers share one in-flight attempt per source, " +
      "and a short hard cooldown applies — a call made too soon is reported as `rate_limited` rather " +
      "than re-fetching. One slow or failing provider never fails the others: every source reports its " +
      "own success, duration and error. Prefer service_status unless you specifically need fresh data.",
    inputSchema: {
      type: "object",
      properties: {
        sourceIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional registered source ids to refresh. Omit to refresh every registered source.",
        },
      },
      required: [],
    },
  }
];

const instructions = [
"- service_status(sourceIds?, includeComponents?, includeIncidents?, includeHistory?, limits…): read the",
  "  CACHED upstream status of the registered services Seam depends on. No network work, returns immediately. When an agent call",
  "  starts failing, check this BEFORE debugging Seam: it tells you whether the provider is down. Each source",
  "  separates `reportedStatus` (what the provider said) from `observation.health` (whether Seam can reach it),",
  "  so \"we cannot currently tell\" never reads as \"the provider is fine\".",
  "- service_status_refresh(sourceIds?): force a bounded live refresh and WAIT for it, when the cached read is",
  "  too old to act on. Concurrent callers share one in-flight attempt per source and a short cooldown applies,",
  "  so a repeat call reports `rate_limited` instead of re-fetching. Partial failure is normal: each source",
  "  returns its own success, duration and error. Prefer service_status unless you specifically need fresh data."
].join("\n");

export function serviceStatusMcp(view: () => Pick<ServiceStatusMcpView, "read" | "refresh" | "registeredSourceIds">): McpContribution[] {
  const sourceHelp = () => `Registered source ids: ${view().registeredSourceIds().join(", ")}.`;
  return descriptors.map((descriptor, index) => ({
    descriptor: {
      ...descriptor,
      get description() { return `${descriptor.description} ${sourceHelp()}`; },
      inputSchema: {
        ...descriptor.inputSchema,
        properties: {
          ...descriptor.inputSchema.properties,
          sourceIds: {
            ...descriptor.inputSchema.properties.sourceIds,
            items: { type: "string", get enum() { return view().registeredSourceIds(); } },
            get description() { return `${descriptor.inputSchema.properties.sourceIds.description} ${sourceHelp()}`; },
          },
        },
      },
    },
    access: "read-only", authorization: "user",
    get instruction() { return index === 0 ? `${instructions}\n  ${sourceHelp()}` : ""; },
    available: () => true,
    handle: async ({ args }) => {
      if (index === 0) {
        const options: ServiceStatusReadOptions = {
          ...spreadIfDefined("sourceIds", optionalStringArray(args, "sourceIds")),
          ...spreadIfDefined("includeComponents", optionalBool(args, "includeComponents")),
          ...spreadIfDefined("includeAllComponents", optionalBool(args, "includeAllComponents")),
          ...spreadIfDefined("includeIncidents", optionalBool(args, "includeIncidents")),
          ...spreadIfDefined(
            "includeResolvedIncidents",
            optionalBool(args, "includeResolvedIncidents")
          ),
          ...spreadIfDefined("includeHistory", optionalBool(args, "includeHistory")),
          ...spreadIfDefined("componentLimit", optionalNumber(args, "componentLimit")),
          ...spreadIfDefined("incidentLimit", optionalNumber(args, "incidentLimit")),
          ...spreadIfDefined("updateLimit", optionalNumber(args, "updateLimit")),
          ...spreadIfDefined("historyLimit", optionalNumber(args, "historyLimit")),
        };
        const result = view().read(options);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }
      const options: ServiceStatusRefreshOptions = {
        ...spreadIfDefined("sourceIds", optionalStringArray(args, "sourceIds")),
      };
      const result = await view().refresh(options);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  }));
}

function optionalBool(args: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}
function optionalNumber(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidArgumentError(new Error(`"${key}" must be a finite number`));
  return value;
}
function optionalStringArray(args: Readonly<Record<string, unknown>>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalidArgumentError(new Error(`"${key}" must be an array of strings`));
  const result = value.map(entry => typeof entry === "string" ? entry.trim() : "");
  if (result.some(entry => !entry)) throw invalidArgumentError(new Error(`"${key}" must contain only non-empty strings`));
  return result.length ? result : undefined;
}
function spreadIfDefined<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
