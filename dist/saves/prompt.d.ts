export interface PromptCopy {
    text: string;
    primary: string;
    secondary: string;
}
export type PromptAnswer = "primary" | "secondary";
export interface PromptHost {
    ask(copy: PromptCopy): Promise<PromptAnswer>;
}
export declare const CONFLICT_COPY: PromptCopy;
export declare const OWNERSHIP_COPY: PromptCopy;
/** `doc` is resolved when a prompt is first shown, so the host can be created where there is no DOM yet. */
export declare function createDomPromptHost(doc?: Document): PromptHost;
