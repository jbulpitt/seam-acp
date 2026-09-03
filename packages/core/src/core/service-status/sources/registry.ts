import {
  createGoogleAiStudioAdapter,
  AI_STUDIO_BOOTSTRAP_URL,
  AI_STUDIO_RPC_URL,
} from "./google-ai-studio.js";
import {
  createGoogleCloudAdapter,
  GOOGLE_CLOUD_INCIDENTS_URL,
  GOOGLE_CLOUD_PRODUCTS_URL,
} from "./google-cloud.js";
import { createLinkworksAdapter, LINKWORKS_LIVE_URL } from "./linkworks.js";
import { createStatuspageAdapter } from "./statuspage.js";
import { createXaiAdapter, XAI_FEED_URL } from "./xai.js";
import type { ServiceStatusSourceDefinition } from "../types.js";

/**
 * The registered upstream sources.
 *
 * Six are the vendor's own status surface (`official`). The seventh, Linkworks,
 * is an independently operated synthetic probe (`external_synthetic`) and is
 * explicitly **not** official Ollama Cloud health — its provenance and scope
 * note exist so no downstream surface can present it as such.
 */

/**
 * Google Cloud product ids from `products.json`. These are opaque and stable
 * across product renames; the titles beside them are only a reading aid.
 */
export const GOOGLE_CLOUD_PRODUCT_IDS = {
  /** "Gemini Code Assist" */
  geminiCodeAssist: "deUeOEPYanfJ9w8cpyBJ",
  /** "Vertex Gemini API", currently titled "Gemini on Agent Platform" */
  vertexGeminiApi: "Z0FZJAMvEB4j3NbCJs6B",
} as const;

/**
 * Stable Statuspage component ids, verified against both the recorded fixtures
 * and the live pages on 2026-09-03. The names beside them are a reading aid
 * only — the id is what is matched, so a page renaming a component keeps it
 * selected instead of silently dropping out of the effective status.
 */
export const GITHUB_COMPONENT_IDS = {
  apiRequests: "brv1bkgrwx7q",
  gitOperations: "8l4ygp009s5s",
  issues: "kr09ddfgbfsf",
  pullRequests: "hhtssxt0f5v2",
  actions: "br0l2tvcx85d",
  copilot: "pjmpxvq2cmr2",
  copilotAiModelProviders: "cnnb39dkkk82",
} as const;

export const ANTHROPIC_COMPONENT_IDS = {
  /** "Claude API (api.anthropic.com)" */
  claudeApi: "k8w3r06qmzrp",
  /** "Claude Code" */
  claudeCode: "yyzkbfz2thpt",
} as const;

export const OPENAI_COMPONENT_IDS = {
  responses: "01JP8CD9JR3HR6Y7G4Q75N4DVW",
  chatCompletions: "01JMXBRMFE6N2NNT7DG6XZQ6PW",
  codexApi: "01KMP3KP5MGE23B80K1EK4S8PV",
  codexWeb: "01JVCV8YSWZFRSM1G5CVP253SK",
  codexInChatGptDesktop: "01KMKFAMWKQ81YWSE1Z18R6VHR",
  vsCodeExtension: "01KMP3KP5M8X0EBTVW6KN327EE",
} as const;

export function createDefaultServiceStatusSources(): ServiceStatusSourceDefinition[] {
  return [
    {
      id: "github",
      label: "GitHub",
      provenance: "official",
      homepage: "https://www.githubstatus.com",
      scopeNote: "GitHub's own status page, including Copilot and its model providers.",
      fetch: createStatuspageAdapter({
        sourceId: "github",
        label: "GitHub",
        summaryUrl: "https://www.githubstatus.com/api/v2/summary.json",
        incidentsUrl: "https://www.githubstatus.com/api/v2/incidents.json",
        selectedComponentIds: Object.values(GITHUB_COMPONENT_IDS),
      }),
    },
    {
      id: "anthropic",
      label: "Claude",
      provenance: "official",
      homepage: "https://status.claude.com",
      scopeNote:
        "Anthropic's own status page. Every component is stored; the Claude API and Claude Code components drive effective status.",
      fetch: createStatuspageAdapter({
        sourceId: "anthropic",
        label: "Claude",
        summaryUrl: "https://status.claude.com/api/v2/summary.json",
        incidentsUrl: "https://status.claude.com/api/v2/incidents.json",
        selectedComponentIds: Object.values(ANTHROPIC_COMPONENT_IDS),
      }),
    },
    {
      id: "openai",
      label: "OpenAI",
      provenance: "official",
      homepage: "https://status.openai.com",
      scopeNote:
        "OpenAI's own status page. Its summary feed omits `incidents`, so incident history comes from the incidents feed.",
      fetch: createStatuspageAdapter({
        sourceId: "openai",
        label: "OpenAI",
        summaryUrl: "https://status.openai.com/api/v2/summary.json",
        incidentsUrl: "https://status.openai.com/api/v2/incidents.json",
        selectedComponentIds: Object.values(OPENAI_COMPONENT_IDS),
      }),
    },
    {
      id: "xai",
      label: "xAI",
      provenance: "official",
      homepage: "https://status.x.ai",
      scopeNote:
        "xAI's official RSS feed. The Cloudflare-protected HTML page is deliberately not used.",
      fetch: createXaiAdapter({ sourceId: "xai", label: "xAI", feedUrl: XAI_FEED_URL }),
    },
    {
      id: "google-ai-studio",
      label: "Google AI Studio",
      provenance: "official",
      homepage: "https://aistudio.google.com/status",
      scopeNote:
        "Evidence for AI Studio and Gemini API surfaces only. It is not proof that the Antigravity (agy) host itself is healthy.",
      fetch: createGoogleAiStudioAdapter({
        sourceId: "google-ai-studio",
        label: "Google AI Studio",
        bootstrapUrl: AI_STUDIO_BOOTSTRAP_URL,
        rpcUrl: AI_STUDIO_RPC_URL,
      }),
    },
    {
      id: "google-cloud",
      label: "Google Cloud",
      provenance: "official",
      homepage: "https://status.cloud.google.com",
      scopeNote:
        "Google Cloud's own status feeds, filtered to the AI products Seam depends on by stable catalogue id.",
      fetch: createGoogleCloudAdapter({
        sourceId: "google-cloud",
        label: "Google Cloud",
        productsUrl: GOOGLE_CLOUD_PRODUCTS_URL,
        incidentsUrl: GOOGLE_CLOUD_INCIDENTS_URL,
        relevantProductIds: [
          GOOGLE_CLOUD_PRODUCT_IDS.geminiCodeAssist,
          GOOGLE_CLOUD_PRODUCT_IDS.vertexGeminiApi,
        ],
      }),
    },
    {
      id: "linkworks-ollama",
      label: "Ollama endpoints (Linkworks probe)",
      provenance: "external_synthetic",
      homepage: LINKWORKS_LIVE_URL,
      scopeNote:
        "Third-party synthetic probe of an independently operated inference cluster. NOT official Ollama Cloud status and must never be presented as such.",
      fetch: createLinkworksAdapter({
        sourceId: "linkworks-ollama",
        label: "Ollama endpoints (Linkworks probe)",
        url: LINKWORKS_LIVE_URL,
      }),
    },
  ];
}
