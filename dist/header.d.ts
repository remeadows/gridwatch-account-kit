import type { AccountKit } from "./session.js";
export interface MountOptions {
    container?: HTMLElement;
}
export interface MountedHeader {
    unmount(): void;
    refresh(): Promise<void>;
}
/** Always-visible account bar. Plain DOM so it mounts identically in React, Phaser, three.js, and vanilla apps. */
export declare function mountAccountHeader(kit: AccountKit, options?: MountOptions): MountedHeader;
