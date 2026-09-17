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

`kit.saves` is `undefined` without `game`. `store` may resolve `use_cloud` when the player answers the conflict prompt with "Use cloud" — apply it. `reconcile` may resolve `uploaded` or `stored`; both mean the local save you passed in is now the cloud row (only the field name differs, by which path got there). Signed-out calls resolve `signed_out`; nothing is sent. `load`, `store` and `reconcile` never reject and never throw asynchronously — the one exception is a *synchronous* `RangeError` from all three when called with a slot that isn't in `game.slots`, so that mistake surfaces immediately instead of failing an `await` later. The kit keeps `{ revision, dirty }` per user and slot, an ownership record per slot, and one device id, all in `localStorage` under `gw-account-kit.*`.

`store` coalesces calls made within its debounce window (750 ms) into a single flush, and that flush uses one idempotency key across its own retries. A *later*, separate flush (the next debounce window, or a background re-flush) always gets its own key — so if a write actually committed on the server after your retries were exhausted locally (a dropped response, not a dropped request), the next flush can still surface a 409 and prompt once; it is not retried silently forever with a stale key.

A background re-flush — triggered by the `online` event or the tab becoming visible again, for any slot the kit already knows is dirty — never prompts the player. If it hits a 409, the record is simply left dirty for the next foreground `store()` or `reconcile()` call to resolve normally with a prompt; a background flush is not the moment to interrupt play with a "use cloud or keep this one" decision.

Call `kit.saves?.dispose()` when tearing the game down (e.g. on unmount in an SPA): it removes the `online`/`visibilitychange` listeners, closes any prompt dialog that's on screen, and settles every in-flight `store()`/`reconcile()` call with `{ status: "error", error: { code: "http", message: "disposed" } }` instead of leaving them hanging.

## Exports

- **`.`** — Core utilities: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PLAY_ALIASES`, `NEXUS_ORIGIN`, `HANDLE_RE`, `validateHandle`, `validateReturnPath`, `signInUrl`, `createAccountKit`, `mountAccountHeader`, plus the full saves client surface: `createSavesClient`, `CONFLICT_COPY`, `OWNERSHIP_COPY`, `createDomPromptHost`, `createSaveStateStore`, `createTransport`, `withRetry`, `decideReconcile`, and their types (`SaveGameConfig`, `SavesClient`, `LoadResult`, `StoreResult`, `ReconcileResult`, `CloudSave`, `SaveError`, `PromptHost`, `PromptCopy`, `PromptAnswer`, `SaveStateStore`, `SyncRecord`, `Transport`, `TransportResult`, `ReconcileDecision`, `ReconcileInputs`) — enough to assemble a `SavesClient` yourself with a custom transport or prompt host, not just through `createAccountKit`.
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
