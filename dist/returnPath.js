import { NEXUS_ORIGIN, PLAY_ALIASES } from "./config";
const RAW_FORBIDDEN = /\\|%2f|%5c|%2e/i; // backslash or encoded / \ .
const SEGMENT_FORBIDDEN = /(^|\/)\.\.?(\/|$)/; // . or .. segment
const CONSENT = /^\/oauth\/consent$/;
const AUTHORIZATION_ID = /^[A-Za-z0-9_-]+$/;
/** Returns a safe same-origin path to send the player back to, or "/" if `raw` is not one. */
export function validateReturnPath(raw, nexusOrigin = NEXUS_ORIGIN) {
    if (!raw || RAW_FORBIDDEN.test(raw))
        return "/";
    // Check dot segments on the RAW path before new URL() normalizes them away.
    if (SEGMENT_FORBIDDEN.test(raw.split(/[?#]/)[0]))
        return "/";
    let url;
    try {
        url = new URL(raw, nexusOrigin);
    }
    catch {
        return "/";
    }
    if (url.origin !== new URL(nexusOrigin).origin)
        return "/";
    if (raw.startsWith("//"))
        return "/";
    const path = url.pathname;
    if (SEGMENT_FORBIDDEN.test(path))
        return "/";
    if (path === "/")
        return "/";
    if (CONSENT.test(path)) {
        const paramStrings = url.search.slice(1).split('&').filter(p => p);
        const id = url.searchParams.get("authorization_id");
        return paramStrings.length === 1 && id && AUTHORIZATION_ID.test(id) ? `${path}?authorization_id=${id}` : "/";
    }
    const alias = PLAY_ALIASES.find((a) => path.startsWith(`/play/${a}/`));
    return alias ? `${path}${url.search}` : "/";
}
export function signInUrl(returnPath, nexusOrigin = NEXUS_ORIGIN) {
    const safe = validateReturnPath(returnPath, nexusOrigin);
    return `${nexusOrigin}/account/sign-in?return=${encodeURIComponent(safe)}`;
}
