/**
 * The small JSON Schema subset the tool inputs use, plus a validator for it.
 * Plain JSON Schema keeps zod (or any schema library) out of the dependencies:
 * every framework adapter passes these objects through as they are.
 */
export type JsonSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  format?: string;
};

/** The input schema of a tool: always an object. */
export type ObjectSchema = {
  type: "object";
  properties: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties: false;
};

/** USDG amount as a decimal string with at most 6 decimals, e.g. "0.01". */
export const USDG_PATTERN = "^\\d+(\\.\\d{1,6})?$";

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

/** First problem with `value`, as a sentence for the model, or null when it matches. */
export function validate(schema: JsonSchema, value: unknown, path = "input"): string | null {
  if (schema.type) {
    const t = typeOf(value);
    const ok = schema.type === t || (schema.type === "number" && t === "integer");
    if (!ok) return `${path} must be ${schema.type === "integer" ? "an" : "a"} ${schema.type}, got ${t}`;
  }
  if (typeof value === "string") {
    if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} must have at least ${schema.minLength} characters`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} must have at most ${schema.maxLength} characters`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return schema.pattern === USDG_PATTERN ? `${path} must be a USDG amount as a decimal string, e.g. "0.01"` : `${path} has an invalid format`;
    }
  }
  if (schema.type === "object" && value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) return `${path}.${key} is required`;
    }
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const sub = props[key];
      if (sub) {
        const err = validate(sub, v, `${path}.${key}`);
        if (err) return err;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key} is not a known field`;
      } else if (typeof schema.additionalProperties === "object") {
        const err = validate(schema.additionalProperties, v, `${path}.${key}`);
        if (err) return err;
      }
    }
  }
  return null;
}
