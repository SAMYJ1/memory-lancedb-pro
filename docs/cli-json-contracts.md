# Memory CLI JSON Contracts

Stable `openclaw memory-pro ... --json` output is intended for scripts and host integrations.

- Treat the fields documented here as stable.
- Ignore unknown extra fields so additive changes remain non-breaking.
- The executable spec lives in `test/cli-json-contracts.test.mjs`.

## Shared Item Shape

`store`, `update`, `list`, and `recall` all use the same normalized memory item shape:

```json
{
  "id": "string",
  "text": "string",
  "scope": "string",
  "category": "preference|fact|decision|entity|other|reflection",
  "importance": 0.7,
  "timestamp": 1772931900000,
  "memoryCategory": "string",
  "tier": "core|working|peripheral|null"
}
```

## Stable Envelopes

### `memory-pro store --json`

```json
{
  "ok": true,
  "action": "created",
  "item": { "id": "string", "...": "shared item shape" }
}
```

### `memory-pro update --json`

```json
{
  "ok": true,
  "action": "updated",
  "item": { "id": "string", "...": "shared item shape" },
  "fieldsUpdated": ["text", "importance"]
}
```

If an update creates a superseding version instead of mutating in place, `action` becomes `"superseded"` and `oldId` / `newId` are included.

### `memory-pro list --json`

```json
{
  "ok": true,
  "action": "list",
  "count": 2,
  "limit": 20,
  "offset": 0,
  "scopeFilter": ["global"],
  "category": null,
  "items": [{ "id": "string", "...": "shared item shape" }]
}
```

### `memory-pro recall --json`

```json
{
  "ok": true,
  "query": "oolong",
  "count": 1,
  "items": [{ "id": "string", "...": "shared item shape" }]
}
```

### `memory-pro stats --json`

```json
{
  "ok": true,
  "action": "stats",
  "scopeFilter": ["global"],
  "memory": {
    "totalCount": 2,
    "scopeCounts": { "global": 2 },
    "categoryCounts": { "preference": 1, "decision": 1 }
  },
  "scopes": {},
  "retrieval": {
    "mode": "vector",
    "hasFtsSupport": true
  }
}
```

`scopes` is passthrough scope-manager data; consumers should read only the keys they need.

### `memory-pro delete --json`

Success:

```json
{
  "ok": true,
  "action": "deleted",
  "id": "string",
  "scopeFilter": ["global"]
}
```

Not found / access denied:

```json
{
  "ok": false,
  "error": "not_found_or_access_denied",
  "id": "string",
  "scopeFilter": ["global"]
}
```

## Compatibility Note

`memory-pro search --json` currently returns the legacy retrieval result array instead of a normalized envelope. That shape is preserved for compatibility and should be treated separately from the stable envelopes above.
