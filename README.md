# @gridwatch/account-kit

Shared account bar, single Supabase session, and sign-in flow for GridWatch games. This kit provides essential utilities for managing player authentication and session handling across GridWatch game clients.

## Installation

Add to your `package.json`:

```json
{
  "dependencies": {
    "@gridwatch/account-kit": "github:remeadows/gridwatch-account-kit#v0.2.0"
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

### Cloud saves

```ts
const kit = createAccountKit({
  returnPath: "/play/match/",
  game: { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 },
});
const result = await kit.saves!.reconcile("campaign", localCampaign);   // on load, once the session is known
if (result.status === "use_cloud") applyLocally(result.save.payload);
if (result.status === "fresh") applyLocally(defaults());
await kit.saves!.store("campaign", localCampaign);                      // on every local commit (coalesced 750 ms)
```

`kit.saves` is `undefined` without `game`. `store` may resolve `use_cloud` when the player answers the conflict prompt with "Use cloud" — apply it. Signed-out calls resolve `signed_out`; nothing is sent. The kit keeps `{ revision, dirty }` per user and slot, an ownership record per slot, and one device id, all in `localStorage` under `gw-account-kit.*`.

## Exports

- **`.`** — Core utilities: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PLAY_ALIASES`, `NEXUS_ORIGIN`, `HANDLE_RE`, `validateHandle`, `validateReturnPath`, `signInUrl`, `createAccountKit`, `mountAccountHeader`, plus the saves client surface: `createSavesClient`, `CONFLICT_COPY`, `OWNERSHIP_COPY`, and the `SaveGameConfig`, `SavesClient`, `LoadResult`, `StoreResult`, `ReconcileResult`, `CloudSave`, `SaveError` types.
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
