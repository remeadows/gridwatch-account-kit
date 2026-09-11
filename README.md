# @gridwatch/account-kit

Shared account bar, single Supabase session, and sign-in flow for GridWatch games. This kit provides essential utilities for managing player authentication and session handling across GridWatch game clients.

## Installation

Add to your `package.json`:

```json
{
  "dependencies": {
    "@gridwatch/account-kit": "github:remeadows/gridwatch-account-kit#v0.1.1"
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

- **`.`** — Core utilities: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PLAY_ALIASES`, `NEXUS_ORIGIN`, `HANDLE_RE`, `validateHandle`, `validateReturnPath`, `signInUrl`.
- **`./react`** — React components for account management and sign-in flows.
- **`./header.css`** — Shared styles for the account header.
