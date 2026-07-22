# Secrets Handling

Two modes for handling API keys and tokens during sync.

## `keep` mode (default)

Secrets are transmitted as-is inside the tar.gz bundle.

- **Push:** No modification. Secrets travel with the bundle.
- **Pull:** Secrets land on target machine unchanged.

**Use when:** Your cloud backend is private (e.g. your own rclone account). The bundle is encrypted in transit by your cloud provider.

## `strip` mode

Secret values are replaced with `***` placeholders before upload. Key structure is preserved.

- **Push:** Values like `sk-ant-xxx` become `***`. Key names stay.
- **Pull:** If target already has a real value → keep it. If only `***` placeholder → remove, user fills in later.

**Use when:** You don't fully trust the storage backend, or want to keep API keys isolated per machine.

### What gets stripped

Any key ending in `_KEY`, `_TOKEN`, `_SECRET`, or containing `API_KEY`, `AUTH_TOKEN`:

- `settings.json` → `env.ANTHROPIC_AUTH_TOKEN`, `env.OPENAI_API_KEY`, etc.
- `settings.local.json` → same patterns
- `.claude.json` → `mcpServers.<name>.config.FIGMA_API_KEY`, etc.

### After pull with strip mode

```json
// Before (from bundle):
{ "env": { "ANTHROPIC_AUTH_TOKEN": "***" } }

// After pull (target had real value):
{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-ant-real-key" } }

// After pull (target had no value):
{ "env": {} }
// → manually add: "ANTHROPIC_AUTH_TOKEN": "sk-ant-your-key"
```

Run `claude-sync status` to see which fields need attention.
