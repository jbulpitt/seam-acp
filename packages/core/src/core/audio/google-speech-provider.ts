import { GoogleAuth } from "google-auth-library";

export type GeminiSpeechProvider = "developer" | "vertex";

export interface GeminiSpeechAuth {
  provider?: GeminiSpeechProvider;
  apiKey?: string;
  vertexProjectId?: string;
  vertexLocation?: string;
  /** Test seam. Production resolves a fresh ADC token. */
  accessToken?: string | (() => string | Promise<string>);
}

const cloudAuth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

export function vertexModelUrl(opts: {
  projectId: string;
  location: string;
  model: string;
  method: "generateContent" | "streamGenerateContent";
  sse?: boolean;
}): string {
  const project = encodeURIComponent(opts.projectId);
  const location = encodeURIComponent(opts.location);
  const model = encodeURIComponent(opts.model);
  const suffix = opts.sse ? "?alt=sse" : "";
  return `https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/publishers/google/models/${model}:${opts.method}${suffix}`;
}

export function vertexLiveWsUrl(): string {
  return "wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent";
}

export function vertexModelResource(opts: {
  projectId: string;
  location: string;
  model: string;
}): string {
  return `projects/${opts.projectId}/locations/${opts.location}/publishers/google/models/${opts.model}`;
}

export async function resolveSpeechAccessToken(
  value?: string | (() => string | Promise<string>)
): Promise<string> {
  const supplied = typeof value === "function" ? await value() : value;
  if (supplied?.trim()) return supplied.trim();
  const client = await cloudAuth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Vertex ADC did not return an access token");
  return token.token;
}

export function requireVertexConfig(auth: GeminiSpeechAuth): {
  projectId: string;
  location: string;
} {
  const projectId = auth.vertexProjectId?.trim() ?? "";
  const location = auth.vertexLocation?.trim() || "global";
  if (!projectId) throw new Error("SEAM_GEMINI_VERTEX_PROJECT_ID is not set");
  return { projectId, location };
}
