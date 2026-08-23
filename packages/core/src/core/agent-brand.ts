/**
 * Agent brand keys for status-card icons (#96).
 *
 * The icon names the *service*, not the harness: a Claude-code process pointed
 * at Z.ai / Ollama Cloud / Vertex shows that service's logo, not Claude's.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StructuredPanel } from "./types.js";

const SERVICE_OVERRIDES: ReadonlyArray<{
  test: (id: string) => boolean;
  brand: string;
}> = [
  { test: (id) => id === "zai" || id.startsWith("zai-"), brand: "z-ai" },
  {
    test: (id) => id === "ollama-cloud" || id.startsWith("ollama-cloud-"),
    brand: "ollama-cloud",
  },
  {
    test: (id) => id === "claude-vertex" || id.startsWith("claude-vertex-"),
    brand: "vertex",
  },
];

const ASSET_EXTS = [".png", ".webp", ".jpg", ".jpeg", ".gif"] as const;

export interface BrandAsset {
  brand: string;
  filename: string;
  data: Buffer;
}

/**
 * Resolve `agentId` (and an optional profile.brand override) to the stable
 * brand key that names `assets/agents/<brand>.<ext>`.
 *
 * Service overrides run *before* base-agent grouping so `claude-vertex` is
 * `vertex`, not `claude`.
 */
export function resolveAgentBrand(agentId: string, profileBrand?: string): string {
  const explicit = profileBrand?.trim();
  if (explicit) return explicit;
  const id = agentId.trim();
  if (!id) return id;
  for (const o of SERVICE_OVERRIDES) {
    if (o.test(id)) return o.brand;
  }
  if (id === "copilot" || id.startsWith("copilot-")) return "copilot";
  if (id === "claude" || id.startsWith("claude-")) return "claude";
  return id;
}

export function brandIconUrl(filename: string): string {
  return `attachment://${filename}`;
}

function agentsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "assets/agents"),
    path.resolve(here, "../../../../assets/agents"),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* missing */
    }
  }
  return candidates[0]!;
}

const assetCache = new Map<string, BrandAsset | null>();

/** Load the logo for `brand`, or `null` when no file exists (text-only state). */
export function loadBrandAsset(brand: string): BrandAsset | null {
  if (!brand) return null;
  if (assetCache.has(brand)) return assetCache.get(brand)!;
  const dir = agentsDir();
  for (const ext of ASSET_EXTS) {
    const filename = `${brand}${ext}`;
    const full = path.join(dir, filename);
    try {
      const data = fs.readFileSync(full);
      const asset: BrandAsset = { brand, filename, data };
      assetCache.set(brand, asset);
      return asset;
    } catch {
      /* try next ext */
    }
  }
  assetCache.set(brand, null);
  return null;
}

/** Attach the brand file for a first send. Edits omit `files` so Discord keeps it. */
export function withBrandAttachment(
  panel: StructuredPanel,
  asset: BrandAsset | null
): StructuredPanel {
  if (!asset) return panel;
  return {
    ...panel,
    files: [{ data: asset.data, filename: asset.filename }],
  };
}
