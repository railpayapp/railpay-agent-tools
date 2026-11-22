import { afterEach, describe, expect, it, vi } from "vitest";

import type { PaymentRecord } from "../src/index.js";
import { OTHER, PAY_TO, SELLER, TX, mockWorld } from "./helpers.js";

const ok = (r: unknown) => {
  expect(r).toMatchObject({ ok: true });
  return r as Record<string, any>;
};
const fail = (r: unknown) => {
  expect(r).toMatchObject({ ok: false });
  return r as Record<string, any>;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("session payment log", () => {
  it("records every payment with an id, oldest first, and reports each one", async () => {
    const w = mockWorld();
    const seen: PaymentRecord[] = [];
    const tk = w.toolkit({ allowSend: true, onPayment: (r) => seen.push(r) });

    const a = ok(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    const b = ok(await tk.run("railpay_send", { to: "agt_2", amount: "0.05", memo: "lunch" }));

    expect(a.paid.payment_id).toBe("pay_1");
    expect(b.payment_id).toBe("pay_2");
    const log = tk.payments();
    expect(log).toMatchObject([
      { id: "pay_1", tool: "railpay_fetch", status: "settled", amount_usdg: "0.001", pay_to: PAY_TO, url: `${SELLER}/data`, tx_hash: TX },
      { id: "pay_2", tool: "railpay_send", status: "settled", amount_usdg: "0.05", pay_to: "agt_2", memo: "lunch", tx_hash: TX },
    ]);
    expect(Number.isNaN(Date.parse(log[0]!.at))).toBe(false);
    expect(seen.map((r) => r.id)).toEqual(["pay_1", "pay_2"]);
    expect(tk.session()).toMatchObject({ spent_usdg: "0.051", payments: 2 });
    // The log is a copy, and never holds the signed payment itself.
    log[0]!.status = "unknown";
    expect(tk.payments()[0]!.status).toBe("settled");
    expect(JSON.stringify(tk.payments())).not.toContain("signed-");
    // A send cannot be used as a retry_payment_id, and a settled fetch is already used.
    expect(fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_2" })).error).toMatchObject({ code: "invalid_input" });
    expect(fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_1" })).error).toMatchObject({ code: "payment_already_used" });
  });

  it("does not record refusals or free requests", async () => {
    const w = mockWorld({ price: "500000" });
    const tk = w.toolkit();
    fail(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    ok(await tk.run("railpay_fetch", { url: `${SELLER}/free` }));
    expect(tk.payments()).toEqual([]);
  });

  it("keeps a payment that went out even when onPayment throws", async () => {
    const w = mockWorld();
    const tk = w.toolkit({
      onPayment: () => {
        throw new Error("logger down");
      },
    });
    const r = ok(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(r.paid).toMatchObject({ status: "settled", payment_id: "pay_1" });
    expect(tk.payments()).toHaveLength(1);
  });
});

describe("retry_payment_id", () => {
  it("collects a pending payment without paying twice", async () => {
    const w = mockWorld({ settle: "pending" });
    const seen: PaymentRecord[] = [];
    const tk = w.toolkit({ onPayment: (r) => seen.push(r) });

    const first = ok(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(first.status).toBe(402);
    expect(first.paid).toMatchObject({ status: "pending", payment_id: "pay_1" });
    expect(first.paid.note).toContain('retry_payment_id "pay_1"');

    const second = ok(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_1" }));
    expect(second).toMatchObject({ status: 200, body: '{"answer":42}', paid: { status: "settled", payment_id: "pay_1", retried: true, tx_hash: TX } });

    expect(w.state.signed).toBe(1);
    expect(w.apiCalls("/v1/agent/pay")).toHaveLength(1);
    // Both seller requests carried the same signed payment.
    const paidCalls = w.state.calls.filter((c) => c.signature);
    expect(paidCalls.map((c) => c.signature)).toEqual(["signed-1", "signed-1"]);
    expect(tk.session()).toMatchObject({ spent_usdg: "0.001", payments: 1 });
    expect(tk.payments()[0]!.status).toBe("settled");
    expect(seen.map((r) => `${r.id}:${r.status}`)).toEqual(["pay_1:pending", "pay_1:settled"]);
  });

  it("refuses to reuse a payment that already settled", async () => {
    const w = mockWorld({ settle: "pending" });
    const tk = w.toolkit();
    await tk.run("railpay_fetch", { url: `${SELLER}/data` });
    ok(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_1" }));

    const again = fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_1" }));
    expect(again.error).toMatchObject({ code: "payment_already_used", retryable: false });
    expect(again.error.hint).toContain("Do not retry");
  });

  it("retries a paid request that got no answer", async () => {
    const w = mockWorld({ settle: "network" });
    const tk = w.toolkit();

    const lost = fail(await tk.run("railpay_fetch", { url: `${SELLER}/data` }));
    expect(lost.error.code).toBe("network_error");
    expect(lost.error.hint).toContain('retry_payment_id "pay_1"');
    expect(lost.payment).toMatchObject({ id: "pay_1", status: "unknown" });

    w.state.settle = "settled";
    const r = ok(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_1" }));
    expect(r.paid).toMatchObject({ status: "settled", retried: true });
    expect(w.state.signed).toBe(1);
  });

  it("refuses an unknown id, another url, or an expired payment", async () => {
    const w = mockWorld({ settle: "pending" });
    const tk = w.toolkit();
    await tk.run("railpay_fetch", { url: `${SELLER}/data` });

    expect(fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_9" })).error).toMatchObject({ code: "invalid_input" });
    expect(fail(await tk.run("railpay_fetch", { url: `${OTHER}/data`, retry_payment_id: "pay_1" })).error).toMatchObject({ code: "invalid_input" });
    expect(fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "1" })).error).toMatchObject({ code: "invalid_input" });
    expect(fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_2" })).error).toMatchObject({ code: "invalid_input" });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 301_000);
    const expired = fail(await tk.run("railpay_fetch", { url: `${SELLER}/data`, retry_payment_id: "pay_1" }));
    expect(expired.error).toMatchObject({ code: "payment_expired" });
    expect(expired.error.hint).toContain("Ask the user");
    expect(w.state.signed).toBe(1);
  });
});
