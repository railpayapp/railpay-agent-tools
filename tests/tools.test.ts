import { describe, expect, it } from "vitest";

import { POLICY_CODES, type ToolFailure, type ToolResult } from "../src/index.js";
import { API, MAX_BODY, OTHER, PAY_TO, SELLER, TX, mockWorld } from "./helpers.js";

function fail(r: ToolResult): ToolFailure {
  expect(r.ok).toBe(false);
  return r as ToolFailure;
}

function success(r: ToolResult): Record<string, any> {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r as Record<string, any>;
}

describe("tool list", () => {
  it("offers balance, quote and fetch; send only with allowSend", () => {
    const w = mockWorld();
    expect(w.toolkit().tools.map((t) => t.name)).toEqual(["railpay_balance", "railpay_quote", "railpay_fetch"]);
    expect(w.toolkit({ allowSend: true }).tools.map((t) => t.name)).toEqual(["railpay_balance", "railpay_quote", "railpay_fetch", "railpay_send"]);
  });

  it("gives every tool an object schema, a description and a spends flag", () => {
    const tk = mockWorld().toolkit({ allowSend: true });
    for (const t of tk.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(80);
      expect(typeof t.spends).toBe("boolean");
    }
    expect(tk.tool("railpay_fetch")!.inputSchema.required).toEqual(["url"]);
    expect(tk.tool("railpay_send")!.inputSchema.required).toEqual(["to", "amount"]);
    expect(tk.tools.filter((t) => t.spends).map((t) => t.name)).toEqual(["railpay_fetch", "railpay_send"]);
  });

  it("states this session's limits in the spending tools' descriptions", () => {
    const tk = mockWorld().toolkit({ maxPerCall: "0.05", sessionBudget: "1", allowedHosts: ["seller.test"] });
    const d = tk.tool("railpay_fetch")!.description;
    expect(d).toContain("at most 0.05 USDG per payment");
    expect(d).toContain("a total budget of 1 USDG");
    expect(d).toContain("only these hosts: seller.test");
    expect(tk.tool("railpay_quote")!.description).toContain("Only these hosts can be used: seller.test.");
  });
});

describe("railpay_balance", () => {
  it("returns the wallet, the policy and this session's limits", async () => {
    const w = mockWorld();
    const r = success(await w.toolkit({ maxPerCall: "0.05", sessionBudget: "0.02" }).run("railpay_balance", {}));
    expect(r).toMatchObject({
      id: "agt_1",
      balance_usdg: "2.5",
      eth: "0.0001",
      spent_today_usdg: "0.03",
      left_today_usdg: "0.97",
      policy: { per_request_max_usdg: "0.1", daily_cap_usdg: "1", allow_a2a: true, paused: false },
      limits: { max_per_call_usdg: "0.05", session_budget_usdg: "0.02", session_remaining_usdg: "0.02", allowed_hosts: null, send_enabled: false, max_payment_now_usdg: "0.02" },
      explorer: "https://robinhoodchain.blockscout.com/address/0x1111111111111111111111111111111111111111",
    });
    expect(w.apiCalls("/v1/agent/me")[0]!.auth).toBe("Bearer rp_sk_test");
  });

  it("says max_payment_now is 0 when the agent is paused or broke", async () => {
    const w = mockWorld();
    w.state.agent = { ...w.state.agent, policy: { ...(w.state.agent.policy as object), paused: true } };
    expect(success(await w.toolkit().run("railpay_balance", {})).limits.max_payment_now_usdg).toBe("0");
    w.state.agent = { ...w.state.agent, balance: 400, policy: { ...(w.state.agent.policy as object), paused: false } };
    expect(success(await w.toolkit().run("railpay_balance", {})).limits.max_payment_now_usdg).toBe("0.0004");
  });

  it("needs an agent key", async () => {
    const w = mockWorld();
    const r = fail(await w.toolkit({ apiKey: undefined }).run("railpay_balance", {}));
    expect(r.error).toMatchObject({ code: "missing_agent_key", source: "config" });
    expect(w.state.calls).toHaveLength(0);
  });
});

describe("railpay_quote", () => {
  it("reads the price without paying and works without a key", async () => {
    const w = mockWorld();
    const r = success(await w.toolkit({ apiKey: undefined }).run("railpay_quote", { url: `${SELLER}/data` }));
    expect(r).toMatchObject({
      status: 402,
      payable: true,
      price_usdg: "0.001",
      amount_units: "1000",
      pay_to: PAY_TO,
      network: "eip155:4663",
      scheme: "exact",
      description: "Test data",
      max_timeout_seconds: 300,
      within_limits: true,
    });
    expect(r.note).toContain("would pay 0.001 USDG");
    expect(w.state.calls.map((c) => c.url)).toEqual([`${SELLER}/data`]);
  });

  it("flags a price above the local limits", async () => {
    const w = mockWorld({ price: "250000" });
    const over = success(await w.toolkit().run("railpay_quote", { url: `${SELLER}/data` }));
    expect(over).toMatchObject({ payable: true, price_usdg: "0.25", within_limits: false, limit_reason: "over_max_amount" });
    const budget = success(await mockWorld({ price: "5000" }).toolkit({ sessionBudget: "0.004" }).run("railpay_quote", { url: `${SELLER}/data` }));
    expect(budget).toMatchObject({ within_limits: false, limit_reason: "over_session_budget" });
  });

  it("reports free URLs, other payment schemes and redirects", async () => {
    const w = mockWorld();
    expect(success(await w.toolkit().run("railpay_quote", { url: `${SELLER}/free` }))).toMatchObject({ status: 200, payable: false });
    const base = success(await mockWorld({ network: "eip155:8453" }).toolkit().run("railpay_quote", { url: `${SELLER}/data` }));
    expect(base).toMatchObject({ status: 402, payable: false, options: [{ network: "eip155:8453", payable_by_railpay: false }] });
    expect(success(await w.toolkit().run("railpay_quote", { url: `${SELLER}/moved` }))).toMatchObject({ status: 302, payable: false, redirect: `${SELLER}/data` });
  });

  it("refuses hosts outside allowedHosts before any request", async () => {
    const w = mockWorld();
    const r = fail(await w.toolkit({ allowedHosts: ["seller.test"] }).run("railpay_quote", { url: `${OTHER}/data` }));
    expect(r.error).toMatchObject({ code: "host_not_allowed", source: "guard" });
    expect(w.state.calls).toHaveLength(0);
  });
});

describe("railpay_fetch", () => {
  it("pays an x402 resource and returns the body and the settlement", async () => {
    const w = mockWorld();
    const tk = w.toolkit();
    const r = success(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r).toMatchObject({
      status: 200,
      content_type: "application/json",
      body: '{"answer":42}',
      truncated: false,
      paid: { status: "settled", settled: true, amount_usdg: "0.001", pay_to: PAY_TO, tx_hash: TX, tx_url: `https://robinhoodchain.blockscout.com/tx/${TX}` },
      session: { spent_usdg: "0.001", budget_usdg: null, remaining_usdg: null },
    });
    const pay = JSON.parse(w.apiCalls("/v1/agent/pay")[0]!.body);
    expect(pay.resource).toBe(`${SELLER}/data`);
    expect(pay.payment_required.accepts).toHaveLength(1);
    expect(w.state.calls.at(-1)!.signature).toBe("signed-1");
    expect(tk.session().spent_usdg).toBe("0.001");
  });

  it("refuses a price above maxPerCall without signing", async () => {
    const w = mockWorld({ price: "200000" });
    const r = fail(await w.toolkit().run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r.error).toMatchObject({ code: "over_max_amount", source: "guard", retryable: false });
    expect(r.error.message).toContain("0.2 USDG");
    expect(w.apiCalls("/v1/agent/pay")).toHaveLength(0);
  });

  it("lets max_amount lower the limit but not raise it", async () => {
    const lowered = mockWorld({ price: "5000" });
    expect(fail(await lowered.toolkit().run("railpay_fetch", { url: `${SELLER}/data`, max_amount: "0.001" })).error.code).toBe("over_max_amount");
    const raised = mockWorld({ price: "200000" });
    expect(fail(await raised.toolkit().run("railpay_fetch", { url: `${SELLER}/data`, max_amount: "5" })).error.code).toBe("over_max_amount");
    expect(raised.apiCalls("/v1/agent/pay")).toHaveLength(0);
  });

  it("stops at the session budget", async () => {
    const w = mockWorld({ price: "2000" });
    const tk = w.toolkit({ sessionBudget: "0.005" });
    expect(success(await tk.run("railpay_fetch", { url: `${SELLER}/data` })).paid.settled).toBe(true);
    expect(success(await tk.run("railpay_fetch", { url: `${SELLER}/data` })).session.remaining_usdg).toBe("0.001");
    const r = fail(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r.error).toMatchObject({ code: "over_session_budget", source: "guard" });
    expect(w.apiCalls("/v1/agent/pay")).toHaveLength(2);
  });

  it("holds the budget across parallel calls", async () => {
    const w = mockWorld({ price: "2000", payDelayMs: 20 });
    const tk = w.toolkit({ sessionBudget: "0.003" });
    const results = await Promise.all([1, 2, 3].map(() => tk.run("railpay_fetch", { url: `${SELLER}/data` })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as ToolFailure).error.code)).toEqual(["over_session_budget", "over_session_budget"]);
    expect(w.apiCalls("/v1/agent/pay")).toHaveLength(1);
  });

  it("refuses hosts outside allowedHosts before any request", async () => {
    const w = mockWorld();
    const tk = w.toolkit({ allowedHosts: ["seller.test"] });
    expect(fail(await tk.run("railpay_fetch", { url: `${OTHER}/data` })).error).toMatchObject({ code: "host_not_allowed", source: "guard" });
    expect(w.state.calls).toHaveLength(0);
    expect(success(await tk.run("railpay_fetch", { url: `${SELLER}/data` })).paid.settled).toBe(true);
  });

  it("returns a 402 it cannot pay, with the options", async () => {
    const w = mockWorld({ network: "eip155:8453" });
    const r = success(await w.toolkit().run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r).toMatchObject({ status: 402, paid: null, payment_required: [{ network: "eip155:8453", payable_by_railpay: false }] });
    expect(r.note).toContain("cannot make");
    expect(w.apiCalls("/v1/agent/pay")).toHaveLength(0);
  });

  it("fetches free URLs without paying", async () => {
    const w = mockWorld();
    expect(success(await w.toolkit().run("railpay_fetch", { url: `${SELLER}/free` }))).toMatchObject({ status: 200, body: "hello", paid: null });
    expect(w.apiCalls("/v1/agent/pay")).toHaveLength(0);
  });

  it("truncates long bodies and does not inline binary ones", async () => {
    const w = mockWorld();
    const big = success(await w.toolkit().run("railpay_fetch", { url: `${SELLER}/big` }));
    expect(big.truncated).toBe(true);
    expect(big.body.startsWith("x".repeat(MAX_BODY))).toBe(true);
    expect(big.body).toContain(`…[truncated, ${MAX_BODY * 3} chars in total]`);
    // A huge body is not read to the end.
    const huge = success(await w.toolkit().run("railpay_fetch", { url: `${SELLER}/huge` }));
    expect(huge.body.length).toBeLessThan(MAX_BODY + 50);
    expect(huge.body).toContain(`…[truncated, more than ${MAX_BODY} chars]`);
    const img = success(await w.toolkit().run("railpay_fetch", { url: `${SELLER}/image` }));
    expect(img).toMatchObject({ body: null, binary: true, bytes: 4, content_type: "image/png" });
  });

  it("does not follow redirects", async () => {
    const w = mockWorld();
    const r = success(await w.toolkit().run("railpay_fetch", { url: `${SELLER}/moved` }));
    expect(r).toMatchObject({ status: 302, redirect: `${SELLER}/data`, paid: null });
    expect(w.state.calls.map((c) => c.url)).toEqual([`${SELLER}/moved`]);
  });

  it("sends method, body and headers, but never a model-supplied payment header", async () => {
    const w = mockWorld();
    const tk = w.toolkit();
    const post = success(await tk.run("railpay_fetch", { url: `${SELLER}/echo`, method: "POST", body: "q=1", headers: { "x-test": "1", "PAYMENT-SIGNATURE": "forged" } }));
    expect(JSON.parse(post.body)).toEqual({ method: "POST", body: "q=1" });
    const call = w.state.calls.at(-1)!;
    expect(call.headers["x-test"]).toBe("1");
    expect(call.signature).toBeNull();
    const get = success(await tk.run("railpay_fetch", { url: `${SELLER}/echo`, body: "ignored" }));
    expect(JSON.parse(get.body)).toEqual({ method: "GET", body: "" });
  });

  it("reports a settlement that is still confirming", async () => {
    const w = mockWorld({ settle: "pending" });
    const r = success(await w.toolkit().run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r.status).toBe(402);
    expect(r.paid).toMatchObject({ status: "pending", settled: false, tx_hash: TX });
    expect(r.paid.note).toContain("still confirming");
  });

  it("reports a payment the seller did not accept, and keeps it counted", async () => {
    const w = mockWorld({ settle: "rejected" });
    const tk = w.toolkit();
    const r = success(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r.paid).toMatchObject({ status: "unconfirmed", settled: false, tx_hash: null });
    expect(r.paid.note).toContain("invalid_payload");
    expect(tk.session().spent_usdg).toBe("0.001");
  });

  it("returns a failure with the payment when the paid retry gets no answer", async () => {
    const w = mockWorld({ settle: "network" });
    const tk = w.toolkit();
    const r = fail(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r.error).toMatchObject({ code: "network_error", source: "network" });
    expect(r.error.hint).toContain("may settle");
    expect(r.payment).toMatchObject({ status: "unknown", amount_usdg: "0.001", pay_to: PAY_TO });
    expect(tk.session().spent_usdg).toBe("0.001");
  });

  it("needs an agent key", async () => {
    const w = mockWorld();
    expect(fail(await w.toolkit({ apiKey: undefined }).run("railpay_fetch", { url: `${SELLER}/data` })).error.code).toBe("missing_agent_key");
    expect(w.state.calls).toHaveLength(0);
  });
});

describe("RailPay policy errors", () => {
  it.each(POLICY_CODES)("returns %s as a structured policy refusal and frees the budget", async (code) => {
    const w = mockWorld({ apiError: { status: code === "insufficient_gas" ? 400 : 403, error: code, message: `blocked: ${code}` } });
    const tk = w.toolkit({ sessionBudget: "1" });
    const r = fail(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r.error).toMatchObject({ code, source: "policy", retryable: false, message: `blocked: ${code}` });
    expect(r.error.hint).toMatch(/Tell the user/);
    expect(r.payment).toBeUndefined();
    expect(tk.session()).toMatchObject({ spent_usdg: "0", reserved_usdg: "0" });
  });

  it("marks agent_busy and server errors retryable", async () => {
    const busy = mockWorld({ apiError: { status: 409, error: "agent_busy", message: "busy" } });
    expect(fail(await busy.toolkit().run("railpay_balance", {})).error).toMatchObject({ code: "agent_busy", source: "railpay", retryable: true });
    const down = mockWorld({ apiError: { status: 500, error: "http_500", message: "oops" } });
    expect(fail(await down.toolkit().run("railpay_balance", {})).error).toMatchObject({ retryable: true });
    const offline = mockWorld({ apiDown: true });
    expect(fail(await offline.toolkit().run("railpay_balance", {})).error).toMatchObject({ code: "network_error", source: "network", retryable: true });
  });

  it("reports a rejected key as a setup problem", async () => {
    const w = mockWorld({ apiError: { status: 401, error: "unauthorized", message: "Invalid API key" } });
    expect(fail(await w.toolkit().run("railpay_balance", {})).error).toMatchObject({ code: "unauthorized", source: "config" });
  });
});

describe("railpay_send", () => {
  it("is refused while allowSend is off, whatever the input", async () => {
    const w = mockWorld();
    const tk = w.toolkit();
    expect(tk.tool("railpay_send")).toBeUndefined();
    expect(tk.has("railpay_send")).toBe(true);
    for (const input of [{ to: "agt_2", amount: "0.01" }, {}, "garbage"]) {
      expect(fail(await tk.run("railpay_send", input)).error).toMatchObject({ code: "send_disabled", source: "guard" });
    }
    expect(w.state.calls).toHaveLength(0);
  });

  it("sends USDG to another agent when enabled", async () => {
    const w = mockWorld();
    const tk = w.toolkit({ allowSend: true, sessionBudget: "1" });
    const r = success(await tk.run("railpay_send", { to: "agt_2", amount: "0.05", memo: "thanks" }));
    expect(r).toMatchObject({ status: "settled", amount_usdg: "0.05", to: "agt_2", memo: "thanks", tx_hash: TX, session: { spent_usdg: "0.05", remaining_usdg: "0.95" } });
    expect(JSON.parse(w.apiCalls("/v1/agent/send")[0]!.body)).toEqual({ to: "agt_2", amount: "0.05", memo: "thanks" });
  });

  it("applies the input rules and the per-call cap", async () => {
    const w = mockWorld();
    const tk = w.toolkit({ allowSend: true });
    expect(fail(await tk.run("railpay_send", { to: "0xabc", amount: "0.01" })).error.code).toBe("invalid_input");
    expect(fail(await tk.run("railpay_send", { to: "agt_2", amount: "0" })).error.code).toBe("invalid_amount");
    expect(fail(await tk.run("railpay_send", { to: "agt_2", amount: "0.5" })).error.code).toBe("over_max_amount");
    expect(fail(await tk.run("railpay_send", { to: "agt_2", amount: "0.01", memo: "m".repeat(141) })).error.code).toBe("invalid_input");
    expect(w.apiCalls("/v1/agent/send")).toHaveLength(0);
  });

  it("keeps a send counted when RailPay does not answer", async () => {
    const w = mockWorld({ apiDown: true });
    const tk = w.toolkit({ allowSend: true });
    const r = fail(await tk.run("railpay_send", { to: "agt_2", amount: "0.01" }));
    expect(r.error.code).toBe("network_error");
    expect(r.error.hint).toContain("Do not send again");
    expect(r.payment).toMatchObject({ status: "unknown", amount_usdg: "0.01" });
    expect(tk.session().spent_usdg).toBe("0.01");
  });

  it("frees the budget when the policy blocks a send", async () => {
    const w = mockWorld({ apiError: { status: 403, error: "a2a_not_allowed", message: "off" } });
    const tk = w.toolkit({ allowSend: true });
    expect(fail(await tk.run("railpay_send", { to: "agt_2", amount: "0.01" })).error).toMatchObject({ code: "a2a_not_allowed", source: "policy" });
    expect(tk.session().spent_usdg).toBe("0");
  });
});

describe("input handling", () => {
  it("returns invalid_input instead of throwing", async () => {
    const tk = mockWorld().toolkit();
    expect(fail(await tk.run("railpay_fetch", {})).error).toMatchObject({ code: "invalid_input", message: "input.url is required", source: "input" });
    expect(fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, max_amount: "1e3" })).error.code).toBe("invalid_input");
    expect(fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, extra: 1 })).error.code).toBe("invalid_input");
    expect(fail(await tk.run("railpay_fetch", { url: "ftp://seller.test/x" })).error.code).toBe("invalid_url");
    expect(fail(await tk.run("railpay_fetch", { url: "not a url" })).error.code).toBe("invalid_url");
    expect(fail(await tk.run("railpay_balance", { x: 1 })).error.code).toBe("invalid_input");
  });

  it("answers unknown tools with a refusal", async () => {
    const tk = mockWorld().toolkit();
    expect(fail(await tk.run("railpay_withdraw", {})).error).toMatchObject({ code: "unknown_tool", source: "input" });
    expect(tk.has("railpay_withdraw")).toBe(false);
  });

  it("accepts null or missing input for the tools without fields", async () => {
    const tk = mockWorld().toolkit();
    expect((await tk.run("railpay_balance", null)).ok).toBe(true);
    expect((await tk.run("railpay_balance", undefined)).ok).toBe(true);
  });

  it("talks to the configured RailPay base URL", async () => {
    const w = mockWorld();
    await w.toolkit().run("railpay_balance", {});
    expect(w.state.calls[0]!.url).toBe(`${API}/v1/agent/me`);
  });
});
