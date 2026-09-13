# Project MCP configuration

Seam reads `.mcp.json` from the effective session working directory and adds
its servers to the ACP session configuration, including for Codex. Globally
injected server names remain reserved. A missing file is fine.

## Environment references

Keep credentials in the environment of the Seam service rather than copying
them into project configuration. For example:

```json
{
  "mcpServers": {
    "example": {
      "type": "http",
      "url": "https://mcp.example.invalid/mcp",
      "headers": { "Authorization": "Bearer ${EXAMPLE_TOKEN}" }
    }
  }
}
```

Seam resolves `${NAME}` and `${NAME:-fallback}` in URL, command, argument,
header-value and environment-value strings before handing them to an adapter.
The fallback applies only when the variable is unset; an explicitly empty
variable remains empty. Expansion is single-pass: variable contents are opaque,
not another template. Bare `$NAME`, shell substitutions, nested defaults and
shell evaluation are not supported. Names/keys are not expanded.

References use the Seam process environment (populated by its normal service
configuration), not a new read of a project's `.env` or an inferred remote
host environment. Values in an MCP server's `env` map do not define variables
for expanding other fields. Expansion does not write any files or cache tokens.

If a referenced variable is unset and has no fallback, Seam skips **that MCP
server only** and logs its name and the missing variable names, without header
or credential values. The agent and other MCP servers remain available.
Malformed JSON is reported without quoting configuration contents.

Expansion happens when Seam plans a runtime, for both new and loaded ACP
sessions. It does not hot-reconfigure an already running MCP connection or
refresh the service's environment. After deploying a fix, a resumed runtime
can receive corrected headers without clearing its conversation. Verify actual
tool execution: some servers allow initialization and tool listing even when
their data-access credential is invalid.
