import { describe, expect, it } from "vitest";

import { USDG_PATTERN, validate, type ObjectSchema } from "../src/schema.js";

const schema: ObjectSchema = {
  type: "object",
  properties: {
    url: { type: "string", maxLength: 20 },
    method: { type: "string", enum: ["GET", "POST"] },
    amount: { type: "string", pattern: USDG_PATTERN },
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["url"],
  additionalProperties: false,
};

describe("validate", () => {
  it("accepts a matching object", () => {
    expect(validate(schema, { url: "https://a.test", method: "GET", amount: "0.01", headers: { a: "b" } })).toBeNull();
  });

  it("names the first problem", () => {
    expect(validate(schema, "nope")).toBe("input must be a object, got string");
    expect(validate(schema, {})).toBe("input.url is required");
    expect(validate(schema, { url: 5 })).toBe("input.url must be a string, got integer");
    expect(validate(schema, { url: "x".repeat(21) })).toBe("input.url must have at most 20 characters");
    expect(validate(schema, { url: "u", method: "HEAD" })).toBe("input.method must be one of GET, POST");
    expect(validate(schema, { url: "u", amount: "1.1234567" })).toBe('input.amount must be a USDG amount as a decimal string, e.g. "0.01"');
    expect(validate(schema, { url: "u", extra: true })).toBe("input.extra is not a known field");
    expect(validate(schema, { url: "u", headers: { a: 1 } })).toBe("input.headers.a must be a string, got integer");
  });

  it("ignores fields set to undefined", () => {
    expect(validate(schema, { url: "u", method: undefined })).toBeNull();
  });

  it("USDG_PATTERN takes up to 6 decimals", () => {
    const re = new RegExp(USDG_PATTERN);
    for (const ok of ["0", "1", "0.1", "0.000001", "12.5"]) expect(re.test(ok)).toBe(true);
    for (const bad of ["", ".1", "1.", "-1", "1e3", "0.0000001", " 1"]) expect(re.test(bad)).toBe(false);
  });
});
