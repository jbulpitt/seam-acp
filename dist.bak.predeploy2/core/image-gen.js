/**
 * Image-generation backends used by the `/seam image` slash command.
 * Supports two providers:
 *   - Google AI Studio: Nano Banana 2/Pro (Gemini `generateContent`) and
 *     Imagen 4 (Vertex-style `predict` endpoint shared via AI Studio).
 *   - Black Forest Labs: FLUX 2 family via async polling API.
 *
 * Both providers reduce to a single shape: a `generate(opts)` call that
 * returns one or more base64-encoded PNG/JPEG buffers plus metadata.
 */
import fs from "node:fs/promises";
export const IMAGE_MODELS = [
    {
        id: "nano-banana-2",
        apiId: "gemini-3.1-flash-image-preview",
        displayName: "Nano Banana 2",
        description: "Default. Fast, strong brand handling, edits + refs.",
        provider: "google",
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
        resolutions: ["1K", "2K", "4K"],
        maxReferenceImages: 14,
        maxCount: 4,
    },
    {
        id: "nano-banana-pro",
        apiId: "gemini-3-pro-image-preview",
        displayName: "Nano Banana Pro",
        description: "Highest quality for complex / multi-turn editing.",
        provider: "google",
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
        resolutions: ["1K", "2K", "4K"],
        maxReferenceImages: 14,
        maxCount: 4,
    },
    {
        id: "imagen-4",
        apiId: "imagen-4.0-generate-001",
        displayName: "Imagen 4",
        description: "Polished single-shot hero text-to-image (no refs).",
        provider: "google",
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
        resolutions: ["1K", "2K"],
        maxReferenceImages: 0,
        maxCount: 4,
    },
    {
        id: "flux-2-pro",
        apiId: "flux-2-pro",
        displayName: "FLUX 2 Pro",
        description: "BFL flagship. Custom aspect ratios incl. 21:9.",
        provider: "bfl",
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
        resolutions: ["1K", "2K"],
        maxReferenceImages: 8,
        maxCount: 4,
    },
    {
        id: "flux-2-flex",
        apiId: "flux-2-flex",
        displayName: "FLUX 2 Flex",
        description: "Typography-heavy layouts, precise prompt control.",
        provider: "bfl",
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
        resolutions: ["1K", "2K"],
        maxReferenceImages: 8,
        maxCount: 4,
    },
    {
        id: "flux-2-max",
        apiId: "flux-2-max",
        displayName: "FLUX 2 Max",
        description: "Strongest prompt-following + final-quality output.",
        provider: "bfl",
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
        resolutions: ["1K", "2K"],
        maxReferenceImages: 8,
        maxCount: 4,
    },
    {
        id: "flux-2-klein",
        apiId: "flux-2-klein",
        displayName: "FLUX 2 Klein",
        description: "Lowest latency, high volume, 4 refs max.",
        provider: "bfl",
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
        resolutions: ["1K", "2K"],
        maxReferenceImages: 4,
        maxCount: 4,
    },
];
export function getImageModelById(id) {
    return IMAGE_MODELS.find((m) => m.id === id);
}
/** Compute width/height for FLUX from an aspect ratio + resolution target.
 *  Per BFL spec: dimensions must be multiples of 16, range 64..., total area
 *  ≤ 4 megapixels. We pick the target megapixel count from the resolution
 *  tier (1K ≈ 1MP, 2K ≈ 4MP — the FLUX cap), solve for w/h that hit that
 *  area at the requested aspect ratio, snap to multiples of 16, then trim
 *  if rounding pushed total area over 4MP. */
const FLUX_MAX_PIXELS = 4_000_000;
function fluxDimensions(aspectRatio, resolution) {
    const targetPixels = resolution === "2K" ? FLUX_MAX_PIXELS : 1_048_576;
    const [aw, ah] = aspectRatio.split(":").map(Number);
    const ratio = aw / ah;
    // area = w * h; h = w / ratio  →  area = w^2 / ratio  →  w = √(area * ratio)
    const snap = (n) => Math.max(64, Math.round(n / 16) * 16);
    let width = snap(Math.sqrt(targetPixels * ratio));
    let height = snap(width / ratio);
    // Snapping can push us slightly over 4MP — trim the larger side until under.
    while (width * height > FLUX_MAX_PIXELS) {
        if (width >= height)
            width -= 16;
        else
            height -= 16;
    }
    return { width, height };
}
/** Resolve a Google AI Studio API key from either the raw env value or a
 *  file path (first non-empty line). Returns undefined when neither is set. */
export async function resolveGoogleApiKey(raw, filePath) {
    if (raw && raw.trim())
        return raw.trim();
    if (!filePath)
        return undefined;
    try {
        const content = await fs.readFile(filePath, "utf8");
        const firstLine = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
        return firstLine;
    }
    catch {
        return undefined;
    }
}
// ---------------------------------------------------------------------------
// Google AI Studio (Gemini / Imagen)
// ---------------------------------------------------------------------------
const GOOGLE_AI_BASE = "https://generativelanguage.googleapis.com/v1beta";
async function generateWithGoogle(opts, apiKey) {
    const model = opts.model;
    if (model.id === "imagen-4") {
        return generateWithImagen(opts, apiKey);
    }
    return generateWithGeminiImage(opts, apiKey);
}
/** Gemini multimodal image gen (Nano Banana 2 / Pro). Uses the standard
 *  `:generateContent` endpoint with `responseModalities: ["IMAGE"]` + an
 *  `imageConfig` block carrying the aspect ratio. References (when
 *  supported) ride along as additional content parts with inline data.
 *
 *  Gemini image-gen models reject `candidateCount > 1`, so when the caller
 *  asks for N > 1 we fire N requests in parallel. */
async function generateWithGeminiImage(opts, apiKey) {
    const count = Math.max(1, Math.min(opts.count, opts.model.maxCount));
    const results = await Promise.all(Array.from({ length: count }, () => geminiOneShot(opts, apiKey)));
    return {
        images: results.flatMap((r) => r.images),
        ...(results[0]?.generationId ? { generationId: results[0].generationId } : {}),
    };
}
async function geminiOneShot(opts, apiKey) {
    const url = `${GOOGLE_AI_BASE}/models/${opts.model.apiId}:generateContent`;
    const parts = [{ text: opts.prompt }];
    for (const ref of opts.references ?? []) {
        parts.push({
            inlineData: {
                mimeType: ref.mimeType,
                data: ref.data.toString("base64"),
            },
        });
    }
    const body = {
        contents: [{ role: "user", parts }],
        generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: {
                aspectRatio: opts.aspectRatio,
                imageSize: opts.resolution,
            },
        },
    };
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Gemini image gen failed: ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
    }
    const json = (await res.json());
    const images = [];
    for (const cand of json.candidates ?? []) {
        for (const part of cand.content?.parts ?? []) {
            if (part.inlineData?.data) {
                images.push({
                    data: Buffer.from(part.inlineData.data, "base64"),
                    mimeType: part.inlineData.mimeType ?? "image/png",
                });
            }
        }
    }
    if (images.length === 0) {
        throw new Error("Gemini returned no image data");
    }
    return { images, ...(json.responseId ? { generationId: json.responseId } : {}) };
}
/** Imagen 4: dedicated text-to-image endpoint with `:predict`. Returns
 *  base64-encoded bytes via `predictions[].bytesBase64Encoded`. */
async function generateWithImagen(opts, apiKey) {
    const url = `${GOOGLE_AI_BASE}/models/${opts.model.apiId}:predict`;
    const body = {
        instances: [{ prompt: opts.prompt }],
        parameters: {
            sampleCount: Math.max(1, Math.min(opts.count, opts.model.maxCount)),
            aspectRatio: opts.aspectRatio,
            sampleImageSize: opts.resolution,
        },
    };
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Imagen failed: ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
    }
    const json = (await res.json());
    const images = [];
    for (const p of json.predictions ?? []) {
        if (p.bytesBase64Encoded) {
            images.push({
                data: Buffer.from(p.bytesBase64Encoded, "base64"),
                mimeType: p.mimeType ?? "image/png",
            });
        }
    }
    if (images.length === 0) {
        throw new Error("Imagen returned no image data");
    }
    return { images };
}
// ---------------------------------------------------------------------------
// Black Forest Labs (FLUX 2)
// ---------------------------------------------------------------------------
const BFL_API_BASE = "https://api.bfl.ai/v1";
const BFL_POLL_INTERVAL_MS = 1500;
const BFL_POLL_TIMEOUT_MS = 180_000;
async function generateWithBfl(opts, apiKey) {
    const count = Math.max(1, Math.min(opts.count, opts.model.maxCount));
    // BFL exposes batch via `num_images` on most FLUX 2 endpoints, but a
    // single 4-image request would still come back as one polling task. Run
    // each generation as its own task in parallel so a single slow one
    // doesn't gate the whole batch and so we can collect partial results
    // gracefully if any fail.
    const results = await Promise.all(Array.from({ length: count }, () => bflOneShot(opts, apiKey)));
    return {
        images: results.flatMap((r) => r.images),
        ...(results[0]?.generationId ? { generationId: results[0].generationId } : {}),
    };
}
async function bflOneShot(opts, apiKey) {
    const url = `${BFL_API_BASE}/${opts.model.apiId}`;
    const { width, height } = fluxDimensions(opts.aspectRatio, opts.resolution);
    const body = {
        prompt: opts.prompt,
        aspect_ratio: opts.aspectRatio,
        width,
        height,
        output_format: "png",
    };
    if (opts.references && opts.references.length > 0) {
        body.image_prompts = opts.references.map((r) => r.data.toString("base64"));
    }
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-key": apiKey },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`FLUX submit failed: ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
    }
    const submit = (await res.json());
    const pollUrl = submit.polling_url;
    if (!pollUrl) {
        throw new Error("FLUX submit returned no polling_url");
    }
    const started = Date.now();
    while (Date.now() - started < BFL_POLL_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, BFL_POLL_INTERVAL_MS));
        const pollRes = await fetch(pollUrl, { headers: { "x-key": apiKey } });
        if (!pollRes.ok)
            continue;
        const poll = (await pollRes.json());
        if (poll.status === "Ready" && poll.result) {
            const urls = poll.result.samples ?? (poll.result.sample ? [poll.result.sample] : []);
            if (urls.length === 0)
                throw new Error("FLUX returned no result URLs");
            const downloaded = await Promise.all(urls.map(async (u) => {
                const dl = await fetch(u);
                if (!dl.ok)
                    throw new Error(`FLUX result download failed: ${dl.status}`);
                return Buffer.from(await dl.arrayBuffer());
            }));
            return {
                images: downloaded.map((data) => ({ data, mimeType: "image/png" })),
                ...(submit.id ? { generationId: submit.id } : {}),
            };
        }
        if (poll.status && /error|failed/i.test(poll.status)) {
            throw new Error(`FLUX generation failed with status ${poll.status}`);
        }
    }
    throw new Error("FLUX generation timed out");
}
/** Route a generation request to the right provider. Throws on missing key. */
export async function generateImage(opts, ctx) {
    if (opts.model.provider === "google") {
        if (!ctx.googleApiKey) {
            throw new Error("Google AI Studio API key is not configured.");
        }
        return generateWithGoogle(opts, ctx.googleApiKey);
    }
    if (opts.model.provider === "bfl") {
        if (!ctx.bflApiKey) {
            throw new Error("BFL API key is not configured.");
        }
        return generateWithBfl(opts, ctx.bflApiKey);
    }
    throw new Error(`Unknown provider for model ${opts.model.id}`);
}
//# sourceMappingURL=image-gen.js.map