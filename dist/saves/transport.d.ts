import type { StoreRequest } from "../saves-schema/wire.js";
export type TransportResult = {
    kind: "ok";
    status: number;
    body: unknown;
    retryAfterMs: number | null;
} | {
    kind: "network";
    message: string;
};
export interface Transport {
    load(slot: string, token: string): Promise<TransportResult>;
    store(slot: string, body: StoreRequest, token: string): Promise<TransportResult>;
}
export declare function createTransport(baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number): Transport;
/** Bounded retry (spec §5.4): 3 attempts on network/5xx (500 ms, 1 500 ms); one Retry-After wait on 429. */
export declare function withRetry(attempt: () => Promise<TransportResult>, sleep: (ms: number) => Promise<void>): Promise<TransportResult>;
