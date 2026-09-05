import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MessagePageItem } from "../packages/core/src/core/message-reader.js";
import {
  ASSISTANT_FRAGMENT_GAP_MS,
  ReconstructionBudgetError,
  assembleReconstruction,
  estimateTokens,
  formatOmissionMarker,
  normalizeReconstructionMessage,
  projectDiscordConversation,
  reconstructionBudgetTokens,
  renderLogicalMessage,
  resolveDestinationContextWindow,
  selectOpeningExchanges,
  selectReconstructionRanges,
  stripSeamHarness,
  type LogicalReconstructionMessage,
} from "../packages/core/src/core/reconstruction/index.js";

const SEAM = "seam-bot";
const OTHER = "other-bot";

function post(
  id: string,
  over: Partial<MessagePageItem> & Pick<MessagePageItem, "content" | "authorType">
): MessagePageItem {
  return {
    messageId: id,
    timestampMs: 1_700_000_000_000 + Number(id) * 1000,
    authorId: over.authorType === "bot" ? (over.authorId ?? SEAM) : (over.authorId ?? "human-1"),
    authorName: over.authorName ?? (over.authorType === "bot" ? "Seam" : "Jesse"),
    authorType: over.authorType,
    content: over.content,
    attachmentNames: over.attachmentNames ?? [],
    hasEmbeds: over.hasEmbeds ?? false,
    hasComponents: over.hasComponents ?? false,
  };
}

function msg(
  id: string,
  role: LogicalReconstructionMessage["role"],
  text: string
): LogicalReconstructionMessage {
  return {
    id,
    sourcePostIds: [id],
    role,
    authorName: role === "user" ? "Jesse" : "Seam",
    timestampMs: 1_700_000_000_000 + Number(id.replace(/\D/g, "") || 0) * 1000,
    text,
  };
}

function conversation(humanCount: number, assistant = true): LogicalReconstructionMessage[] {
  const out: LogicalReconstructionMessage[] = [];
  for (let i = 1; i <= humanCount; i++) {
    out.push(msg(String(i * 2 - 1), "user", `prompt ${i} never delete /tmp/secret-${i}`));
    if (assistant) out.push(msg(String(i * 2), "assistant", `reply ${i}`));
  }
  return out;
}

describe("resolveDestinationContextWindow", () => {
  it("uses matching live usage when size is positive", () => {
    expect(
      resolveDestinationContextWindow({
        destinationModel: "claude-opus-4.8",
        lastContextUsage: { model: "claude-opus-4.8", size: 1_000_000 },
        staticContextLimit: 200_000,
      })
    ).toBe(1_000_000);
  });

  it("ignores stale usage from a different model", () => {
    expect(
      resolveDestinationContextWindow({
        destinationModel: "gpt-5.5",
        lastContextUsage: { model: "claude-opus-4.8", size: 1_000_000 },
        staticContextLimit: 400_000,
      })
    ).toBe(400_000);
  });

  it("ignores non-positive usage and falls back to static", () => {
    expect(
      resolveDestinationContextWindow({
        destinationModel: "gpt-5.5",
        lastContextUsage: { model: "gpt-5.5", size: 0 },
        staticContextLimit: 128_000,
      })
    ).toBe(128_000);
  });

  it("fails closed when neither source is available", () => {
    expect(() =>
      resolveDestinationContextWindow({ destinationModel: "mystery" })
    ).toThrow(/cannot resolve a context window/);
  });
});

describe("projectDiscordConversation", () => {
  it("keeps humans as user and only this Seam bot as assistant", () => {
    const logical = projectDiscordConversation(
      [
        post("1", { authorType: "human", content: "hello" }),
        post("2", { authorType: "bot", authorId: SEAM, content: "hi" }),
        post("3", { authorType: "bot", authorId: OTHER, authorName: "Other", content: "intruder" }),
      ],
      { seamBotId: SEAM }
    );
    expect(logical.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi"],
    ]);
  });

  it("excludes embed/component/status/handoff noise via the shared predicate", () => {
    const logical = projectDiscordConversation(
      [
        post("1", { authorType: "human", content: "go" }),
        post("2", { authorType: "bot", authorId: SEAM, content: "status", hasEmbeds: true }),
        post("3", { authorType: "bot", authorId: SEAM, content: "_starting…_" }),
        post("4", { authorType: "bot", authorId: SEAM, content: "_▶ handoff to worker_" }),
        post("5", { authorType: "bot", authorId: SEAM, content: "_✅ report-back from qa_" }),
        post("6", { authorType: "bot", authorId: SEAM, content: "_⌚ wake fired_" }),
        post("7", { authorType: "bot", authorId: SEAM, content: "real reply" }),
      ],
      { seamBotId: SEAM }
    );
    expect(logical.map((m) => m.text)).toEqual(["go", "real reply"]);
  });

  it("excludes a bot Rebuild card embed so it cannot pollute the seed (#217)", () => {
    const logical = projectDiscordConversation(
      [
        post("1", { authorType: "human", content: "please continue" }),
        post("2", {
          authorType: "bot",
          authorId: SEAM,
          content: "Getting ready to continue",
          hasEmbeds: true,
        }),
        post("3", {
          authorType: "bot",
          authorId: SEAM,
          content: "Rebuild",
          hasEmbeds: true,
        }),
        post("4", { authorType: "bot", authorId: SEAM, content: "assistant reply" }),
      ],
      { seamBotId: SEAM }
    );
    expect(logical.map((m) => m.text)).toEqual(["please continue", "assistant reply"]);
    expect(logical.some((m) => /rebuild|getting ready to continue/i.test(m.text))).toBe(false);
  });

  it("strips <seam-harness> blocks when present", () => {
    expect(stripSeamHarness("<seam-harness>\nsecret\n</seam-harness>\nactual")).toBe("actual");
    expect(stripSeamHarness("<seam-harness>unclosed tail")).toBe("");
    const logical = projectDiscordConversation(
      [
        post("1", {
          authorType: "human",
          content: "<seam-harness>Operating context</seam-harness>\nDo the work",
        }),
      ],
      { seamBotId: SEAM }
    );
    expect(logical[0]?.text).toBe("Do the work");
  });

  it("drops messages that are empty after harness stripping", () => {
    const logical = projectDiscordConversation(
      [post("1", { authorType: "human", content: "<seam-harness>only</seam-harness>" })],
      { seamBotId: SEAM }
    );
    expect(logical).toEqual([]);
  });

  it("excludes watch/compact operational notices and webhook bots", () => {
    const logical = projectDiscordConversation(
      [
        post("1", { authorType: "human", content: "go" }),
        post("2", { authorType: "bot", authorId: SEAM, content: "_⌚ watch fired_" }),
        post("3", { authorType: "bot", authorId: SEAM, content: "_🗜 compact started_" }),
        post("4", {
          authorType: "bot",
          authorId: "webhook-1",
          authorName: "GitHub",
          content: "opened a pull request",
        }),
        post("5", { authorType: "bot", authorId: SEAM, content: "real reply" }),
      ],
      { seamBotId: SEAM }
    );
    expect(logical.map((m) => m.text)).toEqual(["go", "real reply"]);
  });

  it("combines split assistant fragments only when timestamps prove one response", () => {
    const a = post("10", { authorType: "bot", authorId: SEAM, content: "part one" });
    const b: MessagePageItem = {
      ...post("11", { authorType: "bot", authorId: SEAM, content: "part two" }),
      timestampMs: a.timestampMs + 500,
    };
    const c: MessagePageItem = {
      ...post("12", { authorType: "bot", authorId: SEAM, content: "later turn" }),
      timestampMs: a.timestampMs + ASSISTANT_FRAGMENT_GAP_MS + 1,
    };
    const logical = projectDiscordConversation([a, b, c], { seamBotId: SEAM });
    expect(logical).toHaveLength(2);
    expect(logical[0]?.text).toBe("part one\n\npart two");
    expect(logical[0]?.sourcePostIds).toEqual(["10", "11"]);
    expect(logical[1]?.text).toBe("later turn");
  });

  it("keeps attachment placeholders", () => {
    const logical = projectDiscordConversation(
      [post("1", { authorType: "human", content: "", attachmentNames: ["shot.png"] })],
      { seamBotId: SEAM }
    );
    expect(logical[0]?.text).toBe("[attachment: shot.png]");
  });
});

describe("opening block", () => {
  it.each([
    [0, 0],
    [9, 18],
    [10, 20],
    [11, 20],
  ] as const)("%s human prompts select %s opening messages", (humans, openingLen) => {
    const opening = selectOpeningExchanges(conversation(humans));
    expect(opening).toHaveLength(openingLen);
    expect(opening.filter((m) => m.role === "user")).toHaveLength(Math.min(humans, 10));
  });

  it("keeps the first ten exchanges byte-for-byte, including fences and negation", () => {
    const special = msg("1", "user", [
      "never run rm -rf /",
      "```ts",
      "const id = 'abc-123';",
      "```",
      "path: /home/ubuntu/Projects/seam-acp/src/index.ts",
    ].join("\n"));
    const opening = selectOpeningExchanges([special, msg("2", "assistant", "ok")]);
    expect(opening[0]?.text).toBe(special.text);
  });

  it("keeps leading assistant fragments so the opening stays a chronological prefix", () => {
    const messages = [msg("0", "assistant", "welcome"), ...conversation(11)];
    const opening = selectOpeningExchanges(messages);
    expect(opening[0]?.text).toBe("welcome");
    expect(opening).toHaveLength(21);
    expect(opening.at(-1)?.text).toBe("reply 10");
    const seed = assembleReconstruction({
      messages,
      contextWindow: 200_000,
      budgetTokens: reconstructionBudgetTokens(200_000),
      sourcePostCount: messages.reduce((n, m) => n + m.sourcePostIds.length, 0),
    });
    expect(seed.text.indexOf("welcome")).toBeLessThan(seed.text.indexOf("prompt 1"));
  });
});

describe("selectReconstructionRanges", () => {
  it("emits the complete conversation once when it fits, with no gap marker", () => {
    const messages = conversation(3);
    const selection = selectReconstructionRanges({
      messages,
      contextWindow: 100_000,
      budgetTokens: reconstructionBudgetTokens(100_000),
      sourcePostCount: 6,
    });
    expect(selection.complete).toBe(true);
    expect(selection.omitted).toHaveLength(0);
    const seed = assembleReconstruction({
      messages,
      contextWindow: 100_000,
      budgetTokens: reconstructionBudgetTokens(100_000),
      sourcePostCount: 6,
    });
    expect(seed.text).not.toContain("Session reconstruction boundary");
    expect(seed.omittedLogicalCount).toBe(0);
  });

  it("inserts one correctly counted boundary when the history does not fit", () => {
    const messages = [
      ...conversation(10),
      msg("99", "user", `middle blob ${"token value ".repeat(400)}`),
      msg("100", "assistant", "middle reply"),
      msg("101", "user", "recent tail"),
    ];
    const window = 2_000;
    const budget = reconstructionBudgetTokens(window);
    const seed = assembleReconstruction({
      messages,
      contextWindow: window,
      budgetTokens: budget,
      sourcePostCount: 26,
    });
    expect(seed.complete).toBe(false);
    expect(seed.text).toContain("Session reconstruction boundary:");
    expect(seed.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(seed.retainedLogicalCount + seed.omittedLogicalCount).toBe(messages.length);
    const matches = seed.text.match(/Session reconstruction boundary:/g);
    expect(matches).toHaveLength(1);
    expect(seed.text).toContain(
      formatOmissionMarker({
        logicalCount: seed.omittedLogicalCount,
        rawPostCount: seed.omittedRawPostCount,
      })
    );
  });

  it("never splits a message and stays at or under 60%", () => {
    const messages = conversation(15);
    const budget = reconstructionBudgetTokens(1200);
    const seed = assembleReconstruction({
      messages,
      contextWindow: 1200,
      budgetTokens: budget,
      sourcePostCount: 30,
    });
    expect(seed.estimatedTokens).toBeLessThanOrEqual(budget);
    for (const message of messages.slice(0, 20)) {
      if (seed.text.includes(message.text) || seed.complete) continue;
    }
    const opening = selectOpeningExchanges(messages);
    for (const message of opening) {
      expect(seed.text).toContain(message.text);
    }
  });

  it("fails before any packing when the opening block exceeds the budget", () => {
    const huge = msg("1", "user", "X".repeat(10_000));
    expect(() =>
      selectReconstructionRanges({
        messages: [huge],
        contextWindow: 200,
        budgetTokens: reconstructionBudgetTokens(200),
        sourcePostCount: 1,
      })
    ).toThrow(ReconstructionBudgetError);
  });
});

describe("riders", () => {
  it("includes channel then thread riders only when present", () => {
    const seed = assembleReconstruction({
      messages: conversation(1),
      contextWindow: 50_000,
      budgetTokens: reconstructionBudgetTokens(50_000),
      sourcePostCount: 2,
      riders: { channel: "channel rule", thread: "thread rule" },
    });
    const channelAt = seed.text.indexOf("## Channel rider");
    const threadAt = seed.text.indexOf("## Thread rider");
    expect(channelAt).toBeGreaterThan(-1);
    expect(threadAt).toBeGreaterThan(channelAt);
    expect(seed.text).toContain("channel rule");
    expect(seed.text).toContain("thread rule");
  });

  it("omits empty rider headings", () => {
    const seed = assembleReconstruction({
      messages: conversation(1),
      contextWindow: 50_000,
      budgetTokens: reconstructionBudgetTokens(50_000),
      sourcePostCount: 2,
    });
    expect(seed.text).not.toContain("## Channel rider");
    expect(seed.text).not.toContain("## Thread rider");
  });
});

describe("conservative normalization", () => {
  it("is deterministic and idempotent", () => {
    const text = "hello   \n\n\n\nworld";
    const once = normalizeReconstructionMessage(text);
    const twice = normalizeReconstructionMessage(once.text);
    expect(twice.text).toBe(once.text);
  });

  it("does not rewrite protected opening directives, negation, or fences", () => {
    const messages = [
      msg("1", "user", "never delete `src/index.ts`\n```\nkeep   this   spacing\n```"),
      msg("2", "assistant", "ok"),
    ];
    const seed = assembleReconstruction({
      messages,
      contextWindow: 50_000,
      budgetTokens: reconstructionBudgetTokens(50_000),
      sourcePostCount: 2,
    });
    expect(seed.text).toContain("never delete `src/index.ts`");
    expect(seed.text).toContain("keep   this   spacing");
  });

  it("replaces exact duplicates and large base64 outside the opening block", () => {
    const messages = conversation(10);
    messages[0] = { ...messages[0]!, text: "first unique opener" };
    messages.push(msg("99", "user", "first unique opener"));
    messages.push(msg("100", "assistant", `payload data:image/png;base64,${"A".repeat(240)}`));
    const seed = assembleReconstruction({
      messages,
      contextWindow: 200_000,
      budgetTokens: reconstructionBudgetTokens(200_000),
      sourcePostCount: messages.length,
    });
    expect(seed.text).toContain("[exact duplicate of an earlier message in this reconstruction]");
    expect(seed.text).toContain("omitted image/png attachment");
    expect(seed.text).not.toContain("A".repeat(240));
  });

  it("substitutes repeated absolute-path prefixes with an in-band legend", () => {
    const text = [
      "/home/ubuntu/Projects/seam-acp/src/a.ts",
      "/home/ubuntu/Projects/seam-acp/src/b.ts",
      "/home/ubuntu/Projects/seam-acp/src/c.ts",
    ].join("\n");
    const once = normalizeReconstructionMessage(text);
    expect(once.text).toContain("Path aliases used in this message:");
    expect(once.text).toContain("$P0 = /home/ubuntu/Projects/seam-acp");
    expect(once.text).toContain("$P0/src/a.ts");
    const twice = normalizeReconstructionMessage(once.text);
    expect(twice.text).toBe(once.text);
  });

  it("does not sample JSON, delete stopwords, or collapse near-duplicates", () => {
    const messages = [
      ...conversation(10),
      msg("99", "user", '{"keep":true,"never":"delete me","count":3}'),
      msg("100", "user", "the quick brown fox and the extra word"),
      msg("101", "user", "the quick brown fox and the extra word!"),
    ];
    const seed = assembleReconstruction({
      messages,
      contextWindow: 200_000,
      budgetTokens: reconstructionBudgetTokens(200_000),
      sourcePostCount: messages.length,
    });
    expect(seed.text).toContain('"keep":true');
    expect(seed.text).toContain('"never":"delete me"');
    expect(seed.text).toContain("the quick brown fox and the extra word");
    expect(seed.text).toContain("the quick brown fox and the extra word!");
    expect(seed.text).not.toContain("[exact duplicate of an earlier message in this reconstruction]");
  });

  it("continues with the uncompressed message when normalization throws", () => {
    const messages = [
      ...conversation(10),
      msg("99", "user", "keep this rest message even if normalize explodes"),
    ];
    const errors: string[] = [];
    const seed = assembleReconstruction({
      messages,
      contextWindow: 200_000,
      budgetTokens: reconstructionBudgetTokens(200_000),
      sourcePostCount: messages.length,
      normalize: () => {
        throw new Error("normalize boom");
      },
      onNormalizeError: ({ messageId }) => errors.push(messageId),
    });
    expect(errors).toEqual(["99"]);
    expect(seed.text).toContain("keep this rest message even if normalize explodes");
  });
});

describe("golden corpus hashes", () => {
  it("records stable output for a representative long thread", () => {
    const messages = conversation(40).map((message, index) =>
      index >= 20 && index < 70
        ? { ...message, text: `${message.text}\n${"detail ".repeat(30)}` }
        : message
    );
    const seed = assembleReconstruction({
      messages,
      contextWindow: 2_000,
      budgetTokens: reconstructionBudgetTokens(2_000),
      sourcePostCount: 80,
      riders: { channel: "stay in this repo" },
    });
    const hash = createHash("sha256").update(seed.text).digest("hex");
    const again = assembleReconstruction({
      messages,
      contextWindow: 2_000,
      budgetTokens: reconstructionBudgetTokens(2_000),
      sourcePostCount: 80,
      riders: { channel: "stay in this repo" },
    });
    expect(seed.complete).toBe(false);
    expect(seed.estimatedTokens).toBeLessThanOrEqual(seed.budgetTokens);
    expect(seed.retainedLogicalCount + seed.omittedLogicalCount).toBe(80);
    expect({
      retainedLogicalCount: seed.retainedLogicalCount,
      omittedLogicalCount: seed.omittedLogicalCount,
      omittedRawPostCount: seed.omittedRawPostCount,
      estimatedTokens: seed.estimatedTokens,
      transformSavedTokens: seed.transformSavedTokens,
      hash,
    }).toEqual({
      retainedLogicalCount: 41,
      omittedLogicalCount: 39,
      omittedRawPostCount: 39,
      estimatedTokens: 1166,
      transformSavedTokens: 13,
      hash: "7620cc4f1fa2f9dfbf5d7f957a8bc5f0248b191528c354d2f3b8bed67dbfa925",
    });
    expect(createHash("sha256").update(again.text).digest("hex")).toBe(hash);
  });
});

describe("render headings", () => {
  it("uses Human — name and Assistant — Seam", () => {
    expect(renderLogicalMessage(msg("1", "user", "hi"))).toBe("Human — Jesse\n\nhi");
    expect(renderLogicalMessage(msg("2", "assistant", "yo"))).toBe("Assistant — Seam\n\nyo");
  });
});

describe("token budget helper", () => {
  it("is floor of 60%", () => {
    expect(reconstructionBudgetTokens(1000)).toBe(600);
    expect(reconstructionBudgetTokens(1001)).toBe(600);
    expect(estimateTokens("abcd")).toBe(1);
  });
});

describe("semantic mutation probes", () => {
  const baselineMessages = conversation(12);
  const baseline = () =>
    assembleReconstruction({
      messages: baselineMessages,
      contextWindow: 1_200,
      budgetTokens: reconstructionBudgetTokens(1_200),
      sourcePostCount: baselineMessages.length,
    });

  it("inserting a foreign bot post does not change the reconstruction", () => {
    const original = projectDiscordConversation(
      [
        post("1", { authorType: "human", content: "hello" }),
        post("2", { authorType: "bot", authorId: SEAM, content: "hi" }),
      ],
      { seamBotId: SEAM }
    );
    const mutated = projectDiscordConversation(
      [
        post("1", { authorType: "human", content: "hello" }),
        post("1b", { authorType: "bot", authorId: OTHER, content: "intruder payload" }),
        post("2", { authorType: "bot", authorId: SEAM, content: "hi" }),
      ],
      { seamBotId: SEAM }
    );
    expect(mutated.map((m) => [m.role, m.text])).toEqual(original.map((m) => [m.role, m.text]));
  });

  it("mutating an opening human prompt changes the seed verbatim", () => {
    const mutated = baselineMessages.map((message) =>
      message.id === "1" ? { ...message, text: "prompt 1 MUTATED never delete /tmp/secret-1" } : message
    );
    const seed = assembleReconstruction({
      messages: mutated,
      contextWindow: 1_200,
      budgetTokens: reconstructionBudgetTokens(1_200),
      sourcePostCount: mutated.length,
    });
    expect(seed.text).toContain("prompt 1 MUTATED never delete /tmp/secret-1");
    expect(createHash("sha256").update(seed.text).digest("hex")).not.toBe(
      createHash("sha256").update(baseline().text).digest("hex")
    );
  });

  it("mutating omitted middle text does not leak into the seed", () => {
    const messages = conversation(40);
    const middle = messages[30]!;
    const seed = assembleReconstruction({
      messages,
      contextWindow: 1_200,
      budgetTokens: reconstructionBudgetTokens(1_200),
      sourcePostCount: messages.length,
    });
    expect(seed.complete).toBe(false);
    expect(seed.text).not.toContain(middle.text);
    const mutated = messages.map((message) =>
      message.id === middle.id ? { ...message, text: "LEAKED OMITTED SECRET" } : message
    );
    const leaked = assembleReconstruction({
      messages: mutated,
      contextWindow: 1_200,
      budgetTokens: reconstructionBudgetTokens(1_200),
      sourcePostCount: mutated.length,
    });
    expect(leaked.text).not.toContain("LEAKED OMITTED SECRET");
    expect(leaked.omittedLogicalCount).toBe(seed.omittedLogicalCount);
  });

  it("mutating a retained recent tail changes the seed", () => {
    const seed = baseline();
    const last = baselineMessages.at(-1)!;
    expect(seed.text).toContain(last.text);
    const mutated = baselineMessages.map((message) =>
      message.id === last.id ? { ...message, text: "recent tail MUTATED" } : message
    );
    const next = assembleReconstruction({
      messages: mutated,
      contextWindow: 1_200,
      budgetTokens: reconstructionBudgetTokens(1_200),
      sourcePostCount: mutated.length,
    });
    expect(next.text).toContain("recent tail MUTATED");
    expect(next.text).not.toContain(last.text);
  });

  it("counts collapsed assistant fragments in the raw omitted post total", () => {
    const merged: LogicalReconstructionMessage = {
      ...msg("50", "assistant", `middle blob ${"token value ".repeat(400)}`),
      sourcePostIds: ["50a", "50b"],
    };
    const messages = [...conversation(11), merged, msg("51", "user", "recent tail")];
    const seed = assembleReconstruction({
      messages,
      contextWindow: 2_000,
      budgetTokens: reconstructionBudgetTokens(2_000),
      sourcePostCount: messages.reduce((n, m) => n + m.sourcePostIds.length, 0),
    });
    expect(seed.complete).toBe(false);
    expect(seed.text).toContain("recent tail");
    expect(seed.text).not.toContain("middle blob");
    expect(seed.omittedRawPostCount).toBe(seed.omittedLogicalCount + 1);
    expect(seed.text).toContain(
      formatOmissionMarker({
        logicalCount: seed.omittedLogicalCount,
        rawPostCount: seed.omittedRawPostCount,
      })
    );
  });
});
