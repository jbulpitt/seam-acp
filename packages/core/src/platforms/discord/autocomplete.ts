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

/** Case-insensitive prefix match on `name`. Empty prefix ⇒ all items. */
export function filterByPrefix<T extends { name: string }>(
  items: readonly T[],
  prefix: string
): T[] {
  const q = prefix.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) => item.name.toLowerCase().startsWith(q));
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
