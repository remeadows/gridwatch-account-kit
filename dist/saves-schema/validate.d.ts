export type Schema = {
    type: "object";
    properties: Readonly<Record<string, Schema>>;
    optional?: readonly string[];
} | {
    type: "record";
    keyPattern: RegExp;
    value: Schema;
} | {
    type: "array";
    items: Schema;
    maxLength?: number;
} | {
    type: "string";
    maxLength?: number;
    pattern?: RegExp;
} | {
    type: "integer";
    min?: number;
    max?: number;
} | {
    type: "number";
    min?: number;
    max?: number;
} | {
    type: "boolean";
};
export declare const LIMITS: Readonly<{
    maxDepth: 32;
    maxItems: 10000;
    maxStringLength: 16384;
}>;
export type ValidationResult = {
    ok: true;
} | {
    ok: false;
    detail: string;
};
export declare function validateAgainst(schema: Schema, value: unknown): ValidationResult;
