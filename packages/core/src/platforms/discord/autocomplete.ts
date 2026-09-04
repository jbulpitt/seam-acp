/**
 * Reusable Discord slash-command autocomplete.
 *
 * Discord requires an autocomplete interaction to `respond()` within 3s and
 * NEVER throw — a throwing handler leaves the focused option broken. This
 * module is the bot-wide plumbing: a small registry keyed by
 * `(subcommandGroup, subcommand, optionName)` plus helpers that cap, filter,
 * and swallow errors. New autocomplete fields register here; they do not
 * grow a one-off branch in the InteractionCreate handler.
 */

export const DISCORD_AUTOCOMPLETE_MAX = 25;

export type AutocompleteChoice = { name: string; value: string };
export type AutocompleteRoundTripPolicy = "canonical" | "opaque";

export type AutocompleteContext = {
  group: string | null;
  subcommand: string | null;
  optionName: string;
  focusedValue: string;
  /** Project scope (parent channel id). Empty/undefined ⇒ no choices (D3). */
  projectScopeId: string | undefined;
  /** Invoking channel/thread id. Thread-scoped responders need this. */
  channelId?: string;
  /** Parent channel id when the command ran in a thread. */
  parentId?: string;
  /** Bound session id (`discord:<threadId>`), if a session row exists. */
  sessionId?: string;
  /** Effective agent id for this thread (preset-aware). */
  agentId?: string;
  /** Other filled string options on this command (sibling values). */
  optionValues?: Readonly<Record<string, string>>;
};

export type AutocompleteResponder = (
  ctx: AutocompleteContext
) => Promise<readonly AutocompleteChoice[]> | readonly AutocompleteChoice[];

export interface AutocompleteInventoryEntry {
  key: string;
  group: string | null;
  subcommand: string | null;
  optionName: string;
  policy: AutocompleteRoundTripPolicy;
}

interface RegisteredAutocomplete extends AutocompleteInventoryEntry {
  responder: AutocompleteResponder;
}

export function autocompleteKey(
  group: string | null,
  subcommand: string | null,
  optionName: string
): string {
  return `${group ?? ""}/${subcommand ?? ""}/${optionName}`;
}

export class AutocompleteRegistry {
  private readonly responders = new Map<string, RegisteredAutocomplete>();

  register(
    group: string | null,
    subcommand: string | null,
    optionName: string,
    policy: AutocompleteRoundTripPolicy,
    responder: AutocompleteResponder
  ): void {
    const key = autocompleteKey(group, subcommand, optionName);
    this.responders.set(key, { key, group, subcommand, optionName, policy, responder });
  }

  get(
    group: string | null,
    subcommand: string | null,
    optionName: string
  ): AutocompleteResponder | undefined {
    const registered = this.responders.get(autocompleteKey(group, subcommand, optionName));
    if (!registered) return undefined;
    return async (ctx) =>
      projectRoundTripChoices(await registered.responder(ctx), registered.policy);
  }

  inventory(): AutocompleteInventoryEntry[] {
    return [...this.responders.values()]
      .map(({ responder: _responder, ...entry }) => entry)
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Convert an exact, currently emitted opaque display label back to its id.
   * Canonical fields and hand-typed ids pass through unchanged for their
   * existing submission validators. Modified, stale, fuzzy, and ambiguous
   * labels also pass through unchanged, which makes those validators fail
   * closed instead of guessing.
   */
  async normalizeSubmission(
    group: string | null,
    subcommand: string | null,
    optionName: string,
    input: string,
    ctx: AutocompleteContext
  ): Promise<string> {
    const registered = this.responders.get(autocompleteKey(group, subcommand, optionName));
    if (!registered || registered.policy === "canonical") return input;
    let choices: AutocompleteChoice[];
    try {
      choices = projectRoundTripChoices(
        await registered.responder({ ...ctx, focusedValue: input }),
        registered.policy
      );
    } catch {
      return input;
    }
    if (choices.some((choice) => choice.value === input)) return input;
    const matches = new Set(
      choices.filter((choice) => choice.name === input).map((choice) => choice.value)
    );
    return matches.size === 1 ? [...matches][0]! : input;
  }
}

/** Apply the selected field's round-trip contract at the registry boundary. */
export function projectRoundTripChoices(
  choices: readonly AutocompleteChoice[],
  policy: AutocompleteRoundTripPolicy
): AutocompleteChoice[] {
  const seen = new Set<string>();
  const out: AutocompleteChoice[] = [];
  for (const choice of choices) {
    // Discord caps both fields at 100. Never truncate a canonical submission:
    // an altered path/model/id would look valid while resolving differently.
    if (choice.value.length < 1 || choice.value.length > 100 || seen.has(choice.value)) continue;
    const name = policy === "canonical" ? choice.value : choice.name.slice(0, 100);
    if (name.length < 1) continue;
    seen.add(choice.value);
    out.push({ name, value: choice.value });
    if (out.length >= DISCORD_AUTOCOMPLETE_MAX) break;
  }
  return out;
}

/** Case-insensitive prefix match on `name` or `value`. Empty prefix ⇒ all items. */
export function filterByPrefix<T extends { name: string; value?: string }>(
  items: readonly T[],
  prefix: string
): T[] {
  const q = prefix.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) => {
    if (item.name.toLowerCase().startsWith(q)) return true;
    return typeof item.value === "string" && item.value.toLowerCase().startsWith(q);
  });
}

/**
 * Map `{name}` rows to Discord choices, de-dupe by value, cap at 25.
 * Discord choice name/value are each max 100 chars. Display metadata may be
 * truncated, but an overlong submitted value is omitted rather than altered.
 */
export function toAutocompleteChoices(
  items: readonly { name: string; value?: string }[],
  cap = DISCORD_AUTOCOMPLETE_MAX
): AutocompleteChoice[] {
  const seen = new Set<string>();
  const out: AutocompleteChoice[] = [];
  for (const item of items) {
    const value = item.value ?? item.name;
    if (value.length < 1 || value.length > 100) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ name: item.name.slice(0, 100), value });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Project-scoped preset autocomplete (D3): no scope ⇒ no choices. Filter is
 * convenience, not enforcement — submit still re-resolves the name.
 */
export function presetAutocompleteChoices(
  presets: readonly { name: string }[],
  prefix: string,
  projectScopeId: string | undefined
): AutocompleteChoice[] {
  if (!projectScopeId) return [];
  return toAutocompleteChoices(filterByPrefix(presets, prefix));
}

/**
 * Filter + cap a `{name, value}` list. Convenience wrapper used by every
 * new slash autocomplete responder.
 */
export function labeledAutocompleteChoices(
  items: readonly { name: string; value: string }[],
  prefix: string
): AutocompleteChoice[] {
  return toAutocompleteChoices(filterByPrefix(items, prefix));
}

/**
 * Token/id picker: human label with the id in parentheses, value = id.
 * Typing either the label prefix or the id prefix matches.
 */
export function tokenAutocompleteChoices(
  tokens: readonly { id: string; label?: string }[],
  prefix: string
): AutocompleteChoice[] {
  return labeledAutocompleteChoices(
    tokens.map((t) => ({
      name: t.label && t.label !== t.id ? `${t.label} (${t.id})` : t.id,
      value: t.id,
    })),
    prefix
  );
}

/**
 * Flatten Discord `interaction.options.data` into name → string value.
 * Nested subcommand / group options are walked. Non-string values skipped.
 */
export function collectStringOptionValues(
  data: ReadonlyArray<{ name?: string; value?: unknown; options?: readonly unknown[] }>
): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (opts: readonly unknown[] | undefined): void => {
    if (!opts) return;
    for (const raw of opts) {
      const o = raw as { name?: string; value?: unknown; options?: unknown[] };
      if (Array.isArray(o.options)) {
        walk(o.options);
        continue;
      }
      if (typeof o.name === "string" && typeof o.value === "string") {
        out[o.name] = o.value;
      }
    }
  };
  walk(data);
  return out;
}

/**
 * Always `respond()`s. On any error (producer throw, Discord reject, …)
 * respond with `[]` and never rethrow — a throwing autocomplete breaks the
 * focused field for the user.
 */
export async function safeAutocompleteRespond(
  respond: (choices: readonly AutocompleteChoice[]) => Promise<void>,
  produce: () => Promise<readonly AutocompleteChoice[]> | readonly AutocompleteChoice[]
): Promise<void> {
  try {
    const choices = await produce();
    await respond([...choices].slice(0, DISCORD_AUTOCOMPLETE_MAX));
  } catch {
    try {
      await respond([]);
    } catch {
      /* already failed to respond — Discord will time the field out */
    }
  }
}
