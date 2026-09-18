# @gridwatch/account-kit

Shared account bar, single Supabase session, and sign-in flow for GridWatch games. This kit provides essential utilities for managing player authentication and session handling across GridWatch game clients.

## Installation

Add to your `package.json`:

```json
{
  "dependencies": {
    "@gridwatch/account-kit": "github:remeadows/gridwatch-account-kit#v0.2.2"
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

`kit.saves` is `undefined` without `game`. `store` may resolve `use_cloud` when the player answers the conflict prompt with "Use cloud" — apply it. `reconcile` may resolve `uploaded` or `stored`; both mean the local save you passed in is now the cloud row (only the field name differs, by which path got there). `reconcile` may resolve `fresh` when the player picks "Start fresh" on a slot owned by another account — apply defaults. "Start fresh" abandons *all* of this user's unsynced work for that slot, not just the local save passed to that call: the record is marked clean, and any payload the client had remembered for a later flush is forgotten too. Signed-out calls resolve `signed_out`; nothing is sent. `load`, `store` and `reconcile` never reject and never throw asynchronously — the one exception is a *synchronous* `RangeError` from all three when called with a slot that isn't in `game.slots`, so that mistake surfaces immediately instead of failing an `await` later. The kit keeps `{ revision, dirty }` per user and slot, an ownership record per slot, and one device id, all in `localStorage` under `gw-account-kit.*`.

`store` coalesces calls made within its debounce window (750 ms) into a single flush, and that flush uses one idempotency key across its own retries. A *later*, separate flush (the next debounce window, or a background re-flush) always gets its own key — so if a write actually committed on the server after your retries were exhausted locally (a dropped response, not a dropped request), the next flush can still surface a 409 and prompt once; it is not retried silently forever with a stale key. A `store()` call is bound to the user this `SavesClient` last observed signed in for itself (via `load`, `reconcile`, or an earlier flush) — not necessarily whoever is signed in globally at that instant, since a `kit.getSession()` call made directly by the account bar or `useAccount` never reaches the saves client. If a *different* user is signed in by the time the debounce window elapses (or by the time a background re-flush picks it up later), the flush is dropped and resolves `signed_out` rather than uploading one account's edits under another account's session — unless the player's choice had already invalidated that commit, which takes precedence and reports `discarded` instead (see the next paragraph). Two `store()` calls for the same slot only coalesce into one flush when this client observed the same user for both; if it observed a *different* user in between (again, only through its own `load`/`reconcile`/flush calls — not a bare `kit.getSession()`), the earlier call is dropped immediately instead of being coalesced — `signed_out`, or `discarded` if the player's choice had already invalidated it — and a fresh debounce window starts for the new call. One consequence: right after a sign-in the saves client hasn't yet observed for itself, its first `store()` call can resolve `signed_out` this way — nothing is lost, it self-heals on the very next `store()`, and calling `reconcile` right after sign-in (as the usage example above already does) avoids it entirely. The one other exception is the very first `store()` call this `SavesClient` instance ever makes before any session has resolved at all; with no prior user to compare against, it proceeds under whoever is signed in once the debounce window elapses, same as today.

Whenever a call resolves `use_cloud` or `fresh` for a slot, any `store` or background re-flush of that slot that user had already queued is dropped rather than sent — including a `store` made so early that the client had not yet observed any session at all, which is the common startup race: the game kicks off its first `reconcile` and the player commits while that call's session lookup or cloud request is still in flight. (Such an unattributed `store` is dropped by *any* discard on that slot, since there is no account to compare it against; the separate *owner* rule described above still does not apply to it.) This is not conditional on the player having been asked anything, let alone on their having rejected a local copy: it applies to a conflict or ownership prompt they answered "Use cloud"/"Start fresh", *and* to a `reconcile` that resolved `use_cloud` on its own — including the very first `reconcile("campaign", null)` on a brand-new device, where there was nothing local and no prompt at all. In every one of those cases the kit's sync record now sits at the cloud revision, so a commit queued before that point would be accepted with no conflict and would overwrite the cloud copy. Instead, a `store` still inside its debounce window, and one whose flush was already waiting its turn behind that call, both resolve `{ status: "error", error: { code: "http", message: "discarded" } }`. That result outranks every other outcome, and for a reason worth stating plainly: the others are the ones you may reasonably retry, and this one must never be retried. So a commit the choice invalidated reports `discarded` whether, in the meantime, the player signed out (which would otherwise be `signed_out`), a *different* user signed in (likewise), or your own `getSession` failed (which would otherwise surface as that error). The only exception is `dispose()`, which outranks it, since a disposed client reports nothing else. The call that resolved `use_cloud`/`fresh` still reports its own result normally, and any `store` made *after* it proceeds as usual — a later commit is never folded into an earlier one that the choice has already invalidated, so it gets its own debounce window and its own flush even if the earlier one had not elapsed yet.

Treat a `discarded` store as **dropped, not failed**: never retry it, and never re-send its payload. The cloud copy won for that slot, and by then the game's local state should already have been replaced by what that call handed back — the `use_cloud` payload, which as noted above must always be applied, or defaults on `fresh` — so retrying would only resurrect the save that was just discarded.

A background re-flush — triggered by the `online` event or the tab becoming visible again, for any slot the kit already knows is dirty — never prompts the player. If it hits a 409, the record is simply left dirty for the next foreground `store()` or `reconcile()` call to resolve normally with a prompt; a background flush is not the moment to interrupt play with a "use cloud or keep this one" decision. For the same reason it never settles an *ownership* question: while the slot's ownership record names a different account, a background re-flush sends nothing and the record simply stays dirty until a foreground `reconcile` asks the player who the local save belongs to (nothing is lost; it waits). A `store` or a background re-flush claims the slot only while its ownership record is unset or already names that account; taking a slot over from another account is always a `reconcile` decision. So a send that finishes after another account claimed the slot still records its own user's new revision, which is truthful for that account's cloud row, but leaves the newer claim in place. A payload the client itself *remembered* — debounced by `store()`, coalesced across `store()` calls, or held for a background re-flush — is never sent under a different user's session than the one that supplied it, on the foreground debounce path above or on a background re-flush, even though this `SavesClient` instance outlives a sign-out/sign-in. `reconcile` is different: the `local` payload is supplied fresh by the caller on every call, not remembered by the client, and `reconcile` resolves its session as late as possible — once that call reaches the front of the slot's queue — so it is sent under whoever is signed in *at that point*, which is why the usage example above calls `reconcile` once the session is already known; the per-slot ownership record and its take-over prompt (`fresh` above) exist precisely for the case where that turns out to be a different account.

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

A hinted call also remembers the `local` payload you pass, so that a background re-flush of a slot
that was *already* dirty sends what the player actually has rather than an earlier failed attempt —
but only when the slot is this account's or unclaimed. On a shared device the local save may belong
to another account (the slot's ownership record names someone else), and whose save it is, is a
question for the take-over prompt, not for a cache: with another owner on record, a hinted call
remembers nothing and anything already remembered for this account is left untouched. So a hinted
`reconcile` that fails before it can prompt — a cloud load that exhausts its retries, say — can
never leave another account's progress queued for upload.

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
