import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authorizeStagedImage,
  createOllamaImageInspector,
  stagedAttachmentOwnerKey,
} from "../packages/core/src/core/vision/ollama-image-inspector.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("Ollama image inspector", () => {
  const ownerId = "discord:thread-vision";
  let root: string;
  let imagePath: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "seam-vision-"));
    const batch = path.join(root, `${stagedAttachmentOwnerKey(ownerId)}-batch-1`);
    await fsp.mkdir(batch);
    imagePath = path.join(batch, "screen.png");
    await fsp.writeFile(imagePath, PNG);
    await authorizeStagedImage(ownerId, imagePath, PNG);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("sends one staged image to the native Ollama Cloud vision endpoint", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ message: { content: "A settings dialog is visible." } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const inspect = createOllamaImageInspector({
      apiKey: "secret-key",
      model: "glm-5.3-flash",
      stagingRoot: root,
      fetchFn: fetchFn as typeof fetch,
    });

    await expect(inspect({ path: imagePath, ownerId, question: "What is shown?" })).resolves.toEqual({
      model: "glm-5.3-flash",
      observations: "A settings dialog is visible.",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://ollama.com/api/chat");
    expect(init?.headers).toEqual({
      authorization: "Bearer secret-key",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "glm-5.3-flash",
      stream: false,
      think: "low",
      options: { temperature: 0, num_predict: 2_048 },
    });
    expect(body.messages[0].images).toEqual([PNG.toString("base64")]);
    expect(body.messages[0].content).toContain("untrusted user content");
    expect(body.messages[0].content).toContain("What is shown?");
  });

  it("refuses paths outside the staged root without contacting Ollama", async () => {
    const outside = path.join(os.tmpdir(), `seam-outside-${Date.now()}.png`);
    await fsp.writeFile(outside, PNG);
    const fetchFn = vi.fn();
    try {
      const inspect = createOllamaImageInspector({
        apiKey: "secret-key",
        model: "glm-5.3-flash",
        stagingRoot: root,
        fetchFn: fetchFn as typeof fetch,
      });
      await expect(inspect({ path: outside, ownerId })).rejects.toThrow(/outside Seam/);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });

  it("refuses symlinks and files without supported image signatures", async () => {
    const batch = path.dirname(imagePath);
    const link = path.join(batch, "link.png");
    await fsp.symlink(imagePath, link);
    const inspect = createOllamaImageInspector({
      apiKey: "secret-key",
      model: "glm-5.3-flash",
      stagingRoot: root,
      fetchFn: vi.fn() as typeof fetch,
    });
    await expect(inspect({ path: link, ownerId })).rejects.toThrow(/symlinks/);

    const fake = path.join(batch, "fake.png");
    const fakeBytes = Buffer.from("not an image");
    await fsp.writeFile(fake, fakeBytes);
    await authorizeStagedImage(ownerId, fake, fakeBytes);
    await expect(inspect({ path: fake, ownerId })).rejects.toThrow(/PNG, JPEG, and WebP/);
  });

  it("refuses a valid staged image owned by another session", async () => {
    const inspect = createOllamaImageInspector({
      apiKey: "secret-key",
      model: "glm-5.3-flash",
      stagingRoot: root,
      fetchFn: vi.fn() as typeof fetch,
    });
    await expect(inspect({ path: imagePath, ownerId: "discord:other-thread" })).rejects.toThrow(
      /does not belong/
    );
  });

  it("refuses staged bytes that were replaced after authorization", async () => {
    const replacement = Buffer.concat([PNG, Buffer.from("replacement")]);
    await fsp.writeFile(imagePath, replacement);
    const fetchFn = vi.fn();
    const inspect = createOllamaImageInspector({
      apiKey: "secret-key",
      model: "glm-5.3-flash",
      stagingRoot: root,
      fetchFn: fetchFn as typeof fetch,
    });
    await expect(inspect({ path: imagePath, ownerId })).rejects.toThrow(/capability/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns secret-safe provider failures", async () => {
    const inspect = createOllamaImageInspector({
      apiKey: "never-echo-this-key",
      model: "glm-5.3-flash",
      stagingRoot: root,
      fetchFn: (async () => new Response("provider secret body", { status: 500 })) as typeof fetch,
    });
    const failure = await inspect({ path: imagePath, ownerId }).catch((err: Error) => err.message);
    expect(failure).toBe("Ollama Cloud vision request failed (HTTP 500)");
    expect(failure).not.toContain("never-echo-this-key");
    expect(failure).not.toContain("provider secret body");
  });

  it("returns a stable secret-safe error for a malformed success response", async () => {
    const inspect = createOllamaImageInspector({
      apiKey: "never-echo-this-key",
      model: "glm-5.3-flash",
      stagingRoot: root,
      fetchFn: (async () =>
        new Response("provider secret body", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const failure = await inspect({ path: imagePath, ownerId }).catch(
      (err: Error) => err.message
    );
    expect(failure).toBe("Ollama Cloud vision returned an invalid response");
    expect(failure).not.toContain("never-echo-this-key");
    expect(failure).not.toContain("provider secret body");
  });
});
