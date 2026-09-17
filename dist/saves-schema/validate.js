export const LIMITS = Object.freeze({ maxDepth: 32, maxItems: 10_000, maxStringLength: 16_384 });
class Budget {
    items = 0;
    count(path) {
        this.items += 1;
        return this.items > LIMITS.maxItems ? `${path}: more than ${LIMITS.maxItems} items` : null;
    }
}
function fail(detail) {
    return { ok: false, detail };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function check(schema, value, path, depth, budget) {
    if (depth > LIMITS.maxDepth)
        return fail(`${path}: deeper than ${LIMITS.maxDepth}`);
    switch (schema.type) {
        case "boolean":
            return typeof value === "boolean" ? { ok: true } : fail(`${path}: expected boolean`);
        case "string": {
            if (typeof value !== "string")
                return fail(`${path}: expected string`);
            const cap = Math.min(schema.maxLength ?? LIMITS.maxStringLength, LIMITS.maxStringLength);
            if (value.length > cap)
                return fail(`${path}: longer than ${cap}`);
            if (schema.pattern && !schema.pattern.test(value))
                return fail(`${path}: does not match pattern`);
            return { ok: true };
        }
        case "integer":
        case "number": {
            const isInteger = schema.type === "integer";
            if (typeof value !== "number" || !Number.isFinite(value))
                return fail(`${path}: expected ${schema.type}`);
            if (isInteger && !Number.isSafeInteger(value))
                return fail(`${path}: expected integer`);
            if (schema.min !== undefined && value < schema.min)
                return fail(`${path}: below minimum ${schema.min}`);
            if (schema.max !== undefined && value > schema.max)
                return fail(`${path}: above maximum ${schema.max}`);
            return { ok: true };
        }
        case "array": {
            if (!Array.isArray(value))
                return fail(`${path}: expected array`);
            if (schema.maxLength !== undefined && value.length > schema.maxLength)
                return fail(`${path}: longer than ${schema.maxLength}`);
            for (let i = 0; i < value.length; i++) {
                const over = budget.count(path);
                if (over)
                    return fail(over);
                const result = check(schema.items, value[i], `${path}[${i}]`, depth + 1, budget);
                if (!result.ok)
                    return result;
            }
            return { ok: true };
        }
        case "record": {
            if (!isRecord(value))
                return fail(`${path}: expected object`);
            for (const [key, child] of Object.entries(value)) {
                const over = budget.count(path);
                if (over)
                    return fail(over);
                if (!schema.keyPattern.test(key))
                    return fail(`${path}.${key}: key does not match pattern`);
                const result = check(schema.value, child, `${path}.${key}`, depth + 1, budget);
                if (!result.ok)
                    return result;
            }
            return { ok: true };
        }
        case "object": {
            if (!isRecord(value))
                return fail(`${path}: expected object`);
            const optional = new Set(schema.optional ?? []);
            for (const key of Object.keys(value)) {
                const over = budget.count(path);
                if (over)
                    return fail(over);
                if (!Object.hasOwn(schema.properties, key))
                    return fail(`${path}.${key}: unknown property`);
            }
            for (const [key, child] of Object.entries(schema.properties)) {
                if (!Object.hasOwn(value, key)) {
                    if (optional.has(key))
                        continue;
                    return fail(`${path}.${key}: required`);
                }
                const result = check(child, value[key], `${path}.${key}`, depth + 1, budget);
                if (!result.ok)
                    return result;
            }
            return { ok: true };
        }
    }
}
export function validateAgainst(schema, value) {
    return check(schema, value, "$", 0, new Budget());
}
