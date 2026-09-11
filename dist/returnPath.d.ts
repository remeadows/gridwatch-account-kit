/** Returns a safe same-origin path to send the player back to, or "/" if `raw` is not one. */
export declare function validateReturnPath(raw: string | null | undefined, nexusOrigin?: string): string;
export declare function signInUrl(returnPath: string, nexusOrigin?: string): string;
