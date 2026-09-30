# gen-ui-service

Target Workspace Host owns bounded, nonsymlink fragment reads. Desktop Local Host owns persisted
widget state and issues sandbox registrations with explicit gen-ui provenance. Remote workspace
content uses the existing remote services route; desktop state uses base services. No new Agent,
MCP server, content publication journal or accepted command queue is introduced.

The execution Host owns an output root under its application data directory and passes that root
to the Agent at process startup. Host reads and Agent context use the same scope-to-directory
function, keyed by workspace identity (path fallback) and session ID. Only that session directory
is readable; workspace files and other sessions are rejected, with no legacy path fallback.
Creation failures surface before the runtime advertises a writable directory. HTML stays on the
execution machine; widget state stays on the desktop. Neither storage belongs in the Git workspace.

State storage is an injected adapter. Atomic file replacement and the existing cross-process file
lock serialize full snapshots; notifications project durable state. Only modelContent is exported
as untrusted next-turn context. Main owns native sandbox resources, not persisted state.
