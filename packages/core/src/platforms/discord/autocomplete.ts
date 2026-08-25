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

export function autocompleteKey(
  group: string | null,
  subcommand: string | null,
  optionName: string
): string {
  return `${group ?? ""}/${subcommand ?? ""}/${optionName}`;
}

export class AutocompleteRegistry {
  private readonly responders = new Map<string, AutocompleteResponder>();

  register(
    group: string | null,
    subcommand: string | null,
    optionName: string,
    responder: AutocompleteResponder
  ): void {
    this.responders.set(autocompleteKey(group, subcommand, optionName), responder);
  }

  get(
    group: string | null,
    subcommand: string | null,
    optionName: string
  ): AutocompleteResponder | undefined {
    return this.responders.get(autocompleteKey(group, subcommand, optionName));
  }
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
 * Discord choice name/value are each max 100 chars.
 */
export function toAutocompleteChoices(
  items: readonly { name: string; value?: string }[],
  cap = DISCORD_AUTOCOMPLETE_MAX
): AutocompleteChoice[] {
  const seen = new Set<string>();
  const out: AutocompleteChoice[] = [];
  for (const item of items) {
    const value = item.value ?? item.name;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ name: item.name.slice(0, 100), value: value.slice(0, 100) });
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
