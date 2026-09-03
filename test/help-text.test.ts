import { describe, it, expect } from "vitest";
import {
  DISCORD_MESSAGE_CONTENT_MAX,
  HELP_PAGE_MAX,
  buildSeamHelpPages,
  seamHelpSections,
} from "../packages/core/src/platforms/discord/help-text.js";
import {
  buildSeamAdminCommand,
  buildSeamCommand,
} from "../packages/core/src/platforms/discord/commands.js";

/**
 * `/seam info help` was a single 2,554-character `reply({ content })` against
 * Discord's 2,000-character cap — so the one command whose whole job is to list
 * the other commands was failing outright (BASE_TYPE_MAX_LENGTH). The split in
 * #151 adds a second command to document, which only makes the body longer.
 *
 * This is the hard regression: every page the handler sends must fit.
 */
describe("/seam info help length (#151)", () => {
  it("emits pages that every fit Discord's 2,000-character content limit", () => {
    const pages = buildSeamHelpPages();
    expect(pages.length).toBeGreaterThan(0);
    for (const [i, page] of pages.entries()) {
      expect(page.length, `page ${i + 1} is ${page.length} chars`).toBeLessThanOrEqual(
        DISCORD_MESSAGE_CONTENT_MAX
      );
      expect(page.length, `page ${i + 1}`).toBeLessThanOrEqual(HELP_PAGE_MAX);
      expect(page.trim().length, `page ${i + 1} is empty`).toBeGreaterThan(0);
    }
  });

  it("stays under the cap even at an absurdly small page budget", () => {
    // Guards the packer itself, not just today's text: a section that cannot
    // fit on a page of its own must still be cut, never emitted whole.
    for (const budget of [80, 200, 500, 1000]) {
      for (const page of buildSeamHelpPages(budget)) {
        expect(page.length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("would NOT fit as one message — the paging is load-bearing, not cosmetic", () => {
    const whole = seamHelpSections().join("\n\n");
    expect(whole.length).toBeGreaterThan(DISCORD_MESSAGE_CONTENT_MAX);
    expect(buildSeamHelpPages().length).toBeGreaterThan(1);
  });

  it("loses no content when split into pages", () => {
    const pages = buildSeamHelpPages();
    for (const section of seamHelpSections()) {
      for (const line of section.split("\n")) {
        if (!line.trim()) continue;
        expect(pages.some((p) => p.includes(line)), line).toBe(true);
      }
    }
  });

  it("documents both commands, and every top-level slot of each", () => {
    const whole = seamHelpSections().join("\n");
    expect(whole).toContain("/seam");
    expect(whole).toContain("/seamadmin");
    for (const opt of buildSeamCommand().toJSON().options ?? []) {
      expect(whole, `/seam ${opt.name}`).toContain(opt.name);
    }
    for (const opt of buildSeamAdminCommand().toJSON().options ?? []) {
      expect(whole, `/seamadmin ${opt.name}`).toContain(opt.name);
    }
  });

  it("names no command path that the builders do not publish", () => {
    // Catches help text left behind by a move (e.g. `/seam debug` after #151).
    const seamTop = new Set((buildSeamCommand().toJSON().options ?? []).map((o) => o.name));
    const adminTop = new Set((buildSeamAdminCommand().toJSON().options ?? []).map((o) => o.name));
    const whole = seamHelpSections().join("\n");
    for (const match of whole.matchAll(/\/seam(admin)?\s+([a-z-]+)/g)) {
      const isAdmin = match[1] === "admin";
      const slot = match[2]!;
      const known = isAdmin ? adminTop : seamTop;
      expect(known.has(slot), `${match[0]} is not a real command path`).toBe(true);
    }
  });
});
