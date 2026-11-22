import { RailPayError } from "railpay-sdk";
import { describe, expect, it } from "vitest";

import { POLICY_CODES, ToolRefusal, toToolError } from "../src/errors.js";

describe("toToolError", () => {
  it.each(POLICY_CODES)("maps the policy code %s to source policy, not retryable", (code) => {
    const e = toToolError(new RailPayError(code === "insufficient_gas" ? 400 : 403, code, "blocked"));
    expect(e).toMatchObject({ code, source: "policy", retryable: false, message: "blocked" });
    expect(e.hint.length).toBeGreaterThan(10);
  });

  it("maps local SDK refusals", () => {
    expect(toToolError(new RailPayError(0, "missing_api_key", "x"))).toMatchObject({ code: "missing_agent_key", source: "config" });
    expect(toToolError(new RailPayError(0, "over_max_amount", "too much"))).toMatchObject({ code: "over_max_amount", source: "guard", retryable: false });
  });

  it("marks transient RailPay answers retryable", () => {
    expect(toToolError(new RailPayError(409, "agent_busy", "busy"))).toMatchObject({ code: "agent_busy", source: "railpay", retryable: true });
    expect(toToolError(new RailPayError(502, "chain_error", "x"))).toMatchObject({ code: "chain_error", retryable: true });
    expect(toToolError(new RailPayError(503, "http_503", "x"))).toMatchObject({ code: "http_503", retryable: true });
    expect(toToolError(new RailPayError(429, "http_429", "x"))).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("maps key and request problems", () => {
    expect(toToolError(new RailPayError(401, "unauthorized", "x"))).toMatchObject({ code: "unauthorized", source: "config" });
    expect(toToolError(new RailPayError(401, "http_401", "x"))).toMatchObject({ code: "unauthorized", source: "config" });
    expect(toToolError(new RailPayError(400, "unknown_recipient", "x"))).toMatchObject({ code: "unknown_recipient", source: "input" });
    expect(toToolError(new RailPayError(400, "unsupported_requirement", "x"))).toMatchObject({ code: "unsupported_requirement", source: "railpay", retryable: false });
  });

  it("recognises a RailPayError from another copy of the SDK", () => {
    const foreign = Object.assign(new Error("blocked"), { name: "RailPayError", status: 403, code: "over_daily_cap" });
    expect(toToolError(foreign)).toMatchObject({ code: "over_daily_cap", source: "policy" });
  });

  it("maps network failures, timeouts and the rest", () => {
    expect(toToolError(new TypeError("fetch failed", { cause: new Error("ECONNRESET") }))).toMatchObject({ code: "network_error", source: "network", retryable: true });
    expect(toToolError(new DOMException("timed out", "TimeoutError"))).toMatchObject({ code: "timeout", retryable: true });
    expect(toToolError(new DOMException("aborted", "AbortError"))).toMatchObject({ code: "timeout", retryable: false });
    expect(toToolError(new RangeError("Not a decimal amount"))).toMatchObject({ code: "invalid_amount", source: "input" });
    expect(toToolError(new TypeError("x is not a function"))).toMatchObject({ code: "internal_error", source: "internal" });
    expect(toToolError(new ToolRefusal("send_disabled", "off", "guard"))).toMatchObject({ code: "send_disabled", source: "guard" });
  });
});
