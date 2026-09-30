# Hide models from selection lists

The controller reads `DATA_DIR/model-hide.json` whenever a model list is requested.
Edits take effect without restarting or rolling out bridges. The file is a JSON
array of patterns. A missing file means no models are hidden; an invalid edit
logs its cause and keeps the last valid list.

Patterns use `[agent[@host]:]model-glob`. Only `*` is a wildcard, and matching is
literal and case-sensitive. A bare pattern applies to every agent and host.
For example, `claude-opus-4*` matches both dotted and hyphenated ids;
`copilot:gpt-5.*` applies only to Copilot; `codex@macbook:gpt-5.*` applies only
to that host's Codex catalog.

Config admins edit the list with `/seamadmin models hide pattern:…`,
`/seamadmin models unhide pattern:…`, and `/seamadmin models list`. Each change
is audited. Agents propose the same edits with
`config_propose({ models: { action: "hide", pattern: "gpt-5.*" } })`; a config
admin must confirm the card before the file changes.

Hiding affects pickers, autocomplete, model/config cards, metadata queries and
value rankings. It never bans a model: exact typed ids, existing thread and
preset pins, default models and runtime recovery keep working. A thread's
current hidden model remains in its own picker with a `(hidden)` marker.

An example starting list:

```json
[
  "claude-opus-4*",
  "claude-fable-5",
  "gpt-5.*",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash"
]
```

`claude-fable-5` does not match `claude-fable-5.1`. `gpt-5.*` does not match
`gpt-5-mini`.
