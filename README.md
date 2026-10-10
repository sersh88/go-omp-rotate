# go-omp-rotate

Manages [OpenCode Go](https://opencode.ai/docs/go/) API keys in [OMP](https://github.com/can1357/oh-my-pi)'s native credential pool. The configured key list is the source of truth; OMP owns credential selection, retries, affinity, and quota handling. (The package name is historical: there is no plugin-side rotation anymore.)

> **Ownership warning.** A non-empty config replaces the entire stored `opencode-go` credential pool on session start and after every `add`/`rm`. There is no off switch or restore mode: other stored `opencode-go` credentials are overwritten, and disabling or uninstalling the plugin leaves the host pool as-is without restoring anything. Back up your credentials before installing or upgrading with a non-empty config.

Inspired by [pi-opencode-go-rotation](https://github.com/lnilluv/pi-opencode-go-rotation) by [lnilluv](https://github.com/lnilluv), published as `npm:@lnilluv/pi-opencode-go-rotation`. This OMP adaptation keeps the `/opencode` command and key-storage idea but delegates credential selection to OMP's native pool.

## Requirements

- OMP with the `authStorage.credentials` pool API (`list`/`set`) and `authStorage.keys.removeRuntime`.
- The `opencode-go` provider and its models registered by OMP; this plugin does not create the provider registration.

## Install

```sh
omp plugin install npm:go-omp-rotate
```

Or from a clone:

```sh
omp plugin link ~/projects/fun/go-omp-rotate
```

After upgrading the plugin in a running OMP session, run `/reload`. Stop older plugin sessions before upgrading so they cannot write the old config format.

Then:

```text
/opencode add personal sk-xxxx
/opencode add work sk-yyyy
```

## How it works

- `keys` in the config file is authoritative for the whole `opencode-go` pool.
- Sync boundaries: `session_start` (including `/reload`) and after successful `add`/`rm`. Nothing runs per-request; there is no polling and no usage fetching.
- Idempotence: the plugin compares credential multisets ignoring row order and skips `pool.set` when the pool already matches, so host credential affinity is not reset needlessly.
- After a successful read or write the plugin removes its own stale runtime override (`removeRuntime`); it never sets a runtime key. An explicit override set elsewhere (another plugin, config, or command) still shadows the pool and must be removed manually.
- Empty config is an explicit no-op: the host pool is left untouched, nothing is cleared, and nothing is auto-imported. The first `add` starts config ownership.
- A compatibility hook projects outgoing `opencode-go` payloads so signed or caller-bound reasoning is not replayed (see `sanitizeReasoningPayload` in `src/pool.ts`). It is provider-scoped, stateless, and unrelated to key selection.

## Commands

| Command | What it does |
|---|---|
| `/opencode` or `/opencode status` | Read-only: key names with 1-based indices, configured count, observed host count. Never exposes key material and never writes the pool |
| `/opencode add <name> <key>` | Persist the key, then synchronize the pool; reports whether both stages succeeded |
| `/opencode rm <n>` | Remove key `n`, then synchronize the pool. The last key cannot be removed |

If persistence succeeds but synchronization fails, the config is kept and the notice says so; retry with `/reload`. `status` never reconciles: a drift shown by `status` is fixed on the next sync boundary.

## Config

```json
{
  "keys": [
    { "name": "personal", "key": "sk-xxx" },
    { "name": "work", "key": "sk-yyy" }
  ]
}
```

- Path: `~/.omp/agent/go-omp-rotate.json` (`0600`, atomic writes), overridable via `GO_OMP_ROTATE_CONFIG`.
- Keys are stored as plaintext; the file is created and kept at `0600`.
- On first read of the default path only, a legacy `~/.pi/agent/opencode-keys.json` is copied once; the old file is kept. An explicit path or env override disables the import.
- Old rotation/pool-mode fields (`activeKeyIndex`, `cooldownMinutes`, `cooldowns`, `quotaBlockedUntil`, `watchdog*`, `lastRequestAt`, `nativePool`) are ignored on read; the first write normalizes the file to keys-only. A pending `nativePool` restore from the previous release is not continued: finish `pool off` on the old release before upgrading.

## Limits and troubleshooting

- Host without the credentials API: every sync reports an error and changes nothing.
- Higher-priority overrides (config `apiKey`, env vars for other flows, foreign runtime pins) win over the pool; the plugin only clears its own stale runtime pin.
- Partial failure (`configuration saved; pool synchronization failed`): fix the host problem, then `/reload`.
- Shared-workspace quotas: several keys from one workspace do not give independent quota, see the [OpenCode Go docs](https://opencode.ai/docs/go/).
- No per-key usage lookup, no manual key selection, no watchdog, no cooldowns: those are the host's job now.

## Development

```sh
bun test
```

Host acceptance (operator, on a real OMP install): verify the actual pool API shape, runtime/config override precedence, and same-model fallback with one invalid and one healthy key; exercise signed-history continuation after reload.

## License

MIT. Copyright (c) 2026 lnilluv, Copyright (c) 2026 sersh88.
