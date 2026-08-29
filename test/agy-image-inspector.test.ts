import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import type { AgentProfile } from "@seam/adapters";
import type { Logger } from "../packages/core/src/lib/logger.js";
import {
  createAgyImageInspector,
  type AgyVisionRuntime,
} from "../packages/core/src/core/vision/agy-image-inspector.js";
import {
  authorizeStagedImage,
  stagedAttachmentOwnerKey,
} from "../packages/core/src/core/vision/ollama-image-inspector.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MODEL = "gemini-3.7-flash-high";
const silent = pino({ level: "silent" }) as unknown as Logger;

describe("Agy image inspector", () => {
  const ownerId = "discord:agy-vision";
  let root: string;
  let imagePath: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "seam-agy-vision-test-"));
    const batch = path.join(root, `${stagedAttachmentOwnerKey(ownerId)}-batch-1`);
    await fsp.mkdir(batch);
    imagePath = path.join(batch, "screen.png");
    await fsp.writeFile(imagePath, PNG);
    await authorizeStagedImage(ownerId, imagePath, PNG);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("runs the exact Gemini model in a private sandbox without shared tools", async () => {
    let eventHandler: Parameters<AgyVisionRuntime["onEvent"]>[0] | undefined;
    let privateCwd = "";
    let promptText = "";
    const profileOptions: Array<Record<string, unknown>> = [];
    const start = vi.fn(async () => {});
    const newSession = vi.fn(async (session: { cwd: string }) => {
      privateCwd = session.cwd;
      return {};
    });
    const prompt = vi.fn(async (text: string) => {
      promptText = text;
      const match = text.match(/Image: (.+)\nQuestion:/);
      expect(match?.[1]).toBeTruthy();
      expect(await fsp.readFile(match![1]!)).toEqual(PNG);
      await eventHandler?.({ kind: "agent-text", text: "A settings dialog is visible." });
      return { stopReason: "end_turn", cancelled: false };
    });
    const dispose = vi.fn(async () => {});

    const inspect = createAgyImageInspector({
      model: MODEL,
      logger: silent,
      stagingRoot: root,
      profileFactory: (options) => {
        profileOptions.push({ ...(options ?? {}) });
        return {
          listPickerModels: async () => [
            { modelId: MODEL, name: "Gemini 3.7 Flash (High)" },
          ],
        } as unknown as AgentProfile;
      },
      runtimeFactory: () => ({
        onEvent: (handler) => {
          eventHandler = handler;
        },
        start,
        newSession,
        prompt,
        dispose,
      }),
    });

    await expect(
      inspect({ path: imagePath, ownerId, question: "What is shown?" })
    ).resolves.toEqual({
      model: MODEL,
      observations: "A settings dialog is visible.",
    });
    expect(profileOptions).toEqual([
      expect.objectContaining({
        defaultModel: MODEL,
        mcpServers: [],
        sandbox: true,
        exposeGlobalStaging: false,
        persistModelSelection: false,
      }),
    ]);
    expect(newSession).toHaveBeenCalledWith({
      cwd: privateCwd,
      model: MODEL,
      strictModel: true,
    });
    expect(promptText).toContain("untrusted user content");
    expect(promptText).not.toContain(imagePath);
    expect(start).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(fsp.access(privateCwd)).rejects.toThrow();
  });

  it("fails closed before inference when the configured model is unavailable", async () => {
    let privateCwd = "";
    const start = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const inspect = createAgyImageInspector({
      model: MODEL,
      logger: silent,
      stagingRoot: root,
      profileFactory: () => ({
        listPickerModels: async () => [
          { modelId: "gemini-other", name: "Other Gemini" },
        ],
      } as unknown as AgentProfile),
      runtimeFactory: () => ({
        onEvent: () => {},
        start,
        newSession: async (session) => {
          privateCwd = session.cwd;
          return {};
        },
        prompt: async () => ({ stopReason: "end_turn", cancelled: false }),
        dispose,
      }),
    });

    await expect(inspect({ path: imagePath, ownerId })).rejects.toThrow(
      `Agy vision model ${MODEL} is unavailable`
    );
    expect(start).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    if (privateCwd) await expect(fsp.access(privateCwd)).rejects.toThrow();
  });

  it("returns a stable error without exposing provider output", async () => {
    const inspect = createAgyImageInspector({
      model: MODEL,
      logger: silent,
      stagingRoot: root,
      profileFactory: () => ({
        listPickerModels: async () => [
          { modelId: MODEL, name: "Gemini 3.7 Flash (High)" },
        ],
      } as unknown as AgentProfile),
      runtimeFactory: () => ({
        onEvent: () => {},
        start: async () => {},
        newSession: async () => ({}),
        prompt: async () => {
          throw new Error("sensitive provider response");
        },
        dispose: async () => {},
      }),
    });

    const failure = await inspect({ path: imagePath, ownerId }).catch(
      (err: Error) => err.message
    );
    expect(failure).toBe("Agy vision inspection failed");
    expect(failure).not.toContain("sensitive provider response");
  });

  it("removes the private image copy when runtime setup fails", async () => {
    let privateDir = "";
    const inspect = createAgyImageInspector({
      model: MODEL,
      logger: silent,
      stagingRoot: root,
      profileFactory: (options) => {
        privateDir = String(options?.dataDir ?? "");
        throw new Error("sensitive setup failure");
      },
    });

    await expect(inspect({ path: imagePath, ownerId })).rejects.toThrow(
      "Agy vision inspection failed"
    );
    expect(privateDir).toContain("seam-agy-vision-");
    await expect(fsp.access(privateDir)).rejects.toThrow();
  });
});
