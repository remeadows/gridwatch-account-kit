# @gridwatch/account-kit

Shared account bar, single Supabase session, and sign-in flow for GridWatch games. This kit provides essential utilities for managing player authentication and session handling across GridWatch game clients.

## Installation

Add to your `package.json`:

```json
{
  "dependencies": {
    "@gridwatch/account-kit": "github:remeadows/gridwatch-account-kit#v0.1.2"
  }
}
```

Then run `npm install`.

## Usage

```ts
import { createAccountKit, mountAccountHeader } from "@gridwatch/account-kit";
import "@gridwatch/account-kit/header.css";

const kit = createAccountKit({ returnPath: "/play/match/" });
mountAccountHeader(kit);
```

## Exports

- **`.`** — Core utilities: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PLAY_ALIASES`, `NEXUS_ORIGIN`, `HANDLE_RE`, `validateHandle`, `validateReturnPath`, `signInUrl`, `createAccountKit`, `mountAccountHeader`.
- **`./react`** — the `useAccount(kit)` React hook (same shape as the apps' former `useAuth`).
- **`./saves-schema`** — the `/api/saves` wire contract shared by the Nexus worker and the kit client: `SAVE_GAMES`, `resolveSaveGame`, `payloadSchemas`, `validatePayload`, `validateAgainst`, `findDeniedKey`, `DENYLIST`, `canonicalJson`, `requestHash`, `sha256Hex`, `MAX_BODY_BYTES`, `UUID_RE`, `SLOT_RE`, `ALIAS_RE`, and the wire types. DOM-free, dependency-free.
- **`./header.css`** — Shared styles for the account header.

`mountAccountHeader` mounts one account bar per document: a second call returns the existing
mount rather than creating another bar (and warns if it was called with a different `kit`).

### Return-path validation

`validateReturnPath` checks the *entire raw value* passed in — including anything that would
end up in the query string or fragment — for encoded traversal or separator tricks, before
checking the parsed URL's origin and applying stricter alias checks to its URL pathname. A value
that fails either check falls back to `/`.
