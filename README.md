# @gridwatch/account-kit

Shared account bar, single Supabase session, and sign-in flow for GridWatch games. This kit provides essential utilities for managing player authentication and session handling across GridWatch game clients.

## Installation

Add to your `package.json`:

```json
{
  "dependencies": {
    "@gridwatch/account-kit": "github:remeadows/gridwatch-account-kit#v0.2.1"
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

A background re-flush — triggered by the `online` event or the tab becoming visible again, for any slot the kit already knows is dirty — never prompts the player. If it hits a 409, the record is simply left dirty for the next foreground `store()` or `reconcile()` call to resolve normally with a prompt; a background flush is not the moment to interrupt play with a "use cloud or keep this one" decision. A background re-flush also only ever sends a payload the same signed-in user handed to this client — a slot's remembered payload from a previous account is never sent under a different account's session, even if this `SavesClient` instance outlives a sign-out/sign-in.

Pass `{ localChanged: true }` as a third argument to `reconcile` when the game knows this slot's
local payload has changes that were never confirmed in the cloud — e.g. the player made edits
while signed out, or `store` calls were held while offline and never flushed. Without it, a sync
record that isn't marked dirty is trusted at face value: if another device has since moved the
cloud forward, `reconcile` silently returns `use_cloud` and replaces the unsynced local progress.
With the hint, a cloud row that's newer than the local record makes `reconcile` ask the player
instead, resolving `use_cloud` (their answer was "Use cloud") or `stored` (their answer was "Keep
this one", and the local payload was uploaded on top of the cloud revision); at equal revisions,
the local copy is uploaded without asking and `reconcile` resolves `stored`. The hint is ignored
when there's no local payload to protect (`local === null`) or no prior record to compare against.

Call `kit.saves?.dispose()` when tearing the game down (e.g. on unmount in an SPA): it removes the `online`/`visibilitychange` listeners, closes any prompt dialog that's on screen, settles calls still waiting on the debounce timer or on a prompt immediately, and marks the client disposed so a call that is mid-request settles with `{ status: "error", error: { code: "http", message: "disposed" } }` as soon as its current transport attempt returns (the deadline below bounds that wait); no state is written after `dispose()`.

### Runtime requirements

`kit.saves` needs `crypto.getRandomValues`, `fetch`, `AbortController`, `localStorage` (falls back to an in-memory store when unavailable, e.g. private mode), and `<dialog>` (falls back to a plain `open` attribute when `HTMLDialogElement.showModal` isn't supported). Each transport *attempt* is bounded by a 15 s deadline (a store that retries three times against a dead network can take about 47 s to resolve), and each request body is capped at 64 KB — a `store`/`reconcile` payload that would exceed it locally resolves `{ status: "error", error: { code: "invalid_payload", ... } }` without ever reaching the network.

## Exports

- **`.`** — Core utilities: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PLAY_ALIASES`, `NEXUS_ORIGIN`, `HANDLE_RE`, `validateHandle`, `validateReturnPath`, `signInUrl`, `createAccountKit`, `mountAccountHeader`, plus the full saves client surface: `createSavesClient`, `CONFLICT_COPY`, `OWNERSHIP_COPY`, `createDomPromptHost`, `createSaveStateStore`, `createTransport`, `withRetry`, `decideReconcile`, and their types (`SaveGameConfig`, `SavesClient`, `LoadResult`, `StoreResult`, `ReconcileResult`, `ReconcileOptions`, `CloudSave`, `SaveError`, `PromptHost`, `PromptCopy`, `PromptAnswer`, `SaveStateStore`, `SyncRecord`, `Transport`, `TransportResult`, `ReconcileDecision`, `ReconcileInputs`) — enough to assemble a `SavesClient` yourself with a custom transport or prompt host, not just through `createAccountKit`.
- **`./react`** — the `useAccount(kit)` React hook (same shape as the apps' former `useAuth`).
- **`./saves-schema`** — the `/api/saves` wire contract shared by the Nexus worker and the kit client: `SAVE_GAMES`, `resolveSaveGame`, `payloadSchemas`, `validatePayload`, `validateAgainst`, `findDeniedKey`, `DENYLIST`, `canonicalJson`, `hasLoneSurrogate`, `requestHash`, `sha256Hex`, `MAX_BODY_BYTES`, `UUID_RE`, `SLOT_RE`, `ALIAS_RE`, and the wire types. DOM-free, dependency-free.
- **`./header.css`** — Shared styles for the account header.

`mountAccountHeader` mounts one account bar per document: a second call returns the existing
mount rather than creating another bar (and warns if it was called with a different `kit`).

### Return-path validation

`validateReturnPath` checks the *entire raw value* passed in — including anything that would
end up in the query string or fragment — for encoded traversal or separator tricks, before
checking the parsed URL's origin and applying stricter alias checks to its URL pathname. A value
that fails either check falls back to `/`.
