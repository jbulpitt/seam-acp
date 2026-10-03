import type { CompletedFence } from "../core/fence-stream.js";
import type { Logger } from "../lib/logger.js";

export const PLUGIN_API_VERSION = 1;

export interface PluginContext {
  logger: Pick<Logger, "info" | "warn" | "error">;
  config: unknown;
}

export interface FenceOutput {
  sendText(text: string): Promise<void>;
  sendFile?: (file: { data: Buffer; filename: string; mimeType: string }) => Promise<void>;
  fallback(notice?: string): Promise<void>;
}

export interface FenceInvocation {
  fence: Readonly<CompletedFence>;
  counter: number;
  notice?: string;
  output: FenceOutput;
}

export interface FenceContribution {
  tag: string;
  aliases?: readonly string[];
  instruction: string;
  handle(invocation: FenceInvocation, context: PluginContext): Promise<void>;
}

export interface Plugin {
  id: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  builtin: true;
  internal?: boolean;
  validateConfig?(config: unknown): unknown;
  activate?(context: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
  contributions: { fences: readonly FenceContribution[] };
}

export interface BuiltinPlugin {
  id: string;
  load(): Promise<Plugin>;
}
