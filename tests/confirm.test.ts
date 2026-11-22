import { describe, expect, it } from "vitest";

import type { PaymentRequest } from "../src/index.js";
import { PAY_TO, SELLER, mockWorld } from "./helpers.js";

describe("confirm callback", () => {
  it("asks before paying, with what the payment is, and pays on true", async () => {
    const w = mockWorld();
    const asked: PaymentRequest[] = [];
    const tk = w.toolkit({
      sessionBudget: "0.01",
      confirm: async (p) => {
        asked.push(p);
        return true;
      },
    });

    const r = (await tk.run("railpay_fetch", { url: `${SELLER}/data` })) as Record<string, any>;

    expect(r).toMatchObject({ ok: true, status: 200, paid: { status: "settled" } });
    expect(asked).toEqual([
      {
        tool: "railpay_fetch",
        amount_usdg: "0.001",
        pay_to: PAY_TO,
        url: `${SELLER}/data`,
        description: "Test data",
        session_spent_usdg: "0",
        session_budget_usdg: "0.01",
      },
    ]);
    expect(w.state.signed).toBe(1);
  });

  it("refuses without signing when the user says no", async () => {
    const w = mockWorld();
    const tk = w.toolkit({ confirm: () => false });

    const r = await tk.run("railpay_fetch", { url: `${SELLER}/data` });

    expect(r).toMatchObject({ ok: false, error: { code: "payment_declined", source: "user", retryable: false } });
    expect(!r.ok && r.error.hint).toContain("Do not retry");
    expect(w.state.signed).toBe(0);
    expect(w.apiCalls("/v1/agent/pay")).toHaveLength(0);
    expect(tk.session()).toMatchObject({ spent_usdg: "0", reserved_usdg: "0" });
  });

  it("treats a throw, or anything but true, as no", async () => {
    for (const confirm of [
      () => {
        throw new Error("prompt closed");
      },
      async () => Promise.reject(new Error("timeout")),
      () => "yes" as unknown as boolean,
    ]) {
      const w = mockWorld();
      const r = await w.toolkit({ confirm }).run("railpay_fetch", { url: `${SELLER}/data` });
      expect(r).toMatchObject({ ok: false, error: { code: "payment_declined" } });
      expect(w.state.signed).toBe(0);
    }
  });

  it("is not asked when a limit already refuses", async () => {
    const w = mockWorld({ price: "500000" });
    let asked = 0;
    const r = await w.toolkit({ confirm: () => ++asked > 0 }).run("railpay_fetch", { url: `${SELLER}/data` });
    expect(r).toMatchObject({ ok: false, error: { code: "over_max_amount" } });
    expect(asked).toBe(0);
  });

  it("holds the budget while the user decides, so a parallel payment cannot use it", async () => {
    const w = mockWorld();
    let approve!: (yes: boolean) => void;
    const tk = w.toolkit({ sessionBudget: "0.001", confirm: () => new Promise<boolean>((resolve) => (approve = resolve)) });

    const first = tk.run("railpay_fetch", { url: `${SELLER}/data` });
    await new Promise((r) => setTimeout(r, 10));
    expect(tk.session()).toMatchObject({ reserved_usdg: "0.001", remaining_usdg: "0" });
    const second = await tk.run("railpay_fetch", { url: `${SELLER}/data` });
    expect(second).toMatchObject({ ok: false, error: { code: "over_session_budget" } });

    approve(true);
    expect(await first).toMatchObject({ ok: true, paid: { status: "settled" } });
    expect(tk.session()).toMatchObject({ spent_usdg: "0.001", reserved_usdg: "0" });
  });

  it("covers railpay_send too", async () => {
    const w = mockWorld();
    const asked: PaymentRequest[] = [];
    const tk = w.toolkit({
      allowSend: true,
      confirm: (p) => {
        asked.push(p);
        return false;
      },
    });

    const r = await tk.run("railpay_send", { to: "agt_2", amount: "0.05", memo: "lunch" });

    expect(r).toMatchObject({ ok: false, error: { code: "payment_declined" } });
    expect(asked[0]).toMatchObject({ tool: "railpay_send", amount_usdg: "0.05", pay_to: "agt_2", memo: "lunch" });
    expect(w.apiCalls("/v1/agent/send")).toHaveLength(0);
  });

  it("tells the model that the user approves each payment", async () => {
    const tk = mockWorld().toolkit({ confirm: () => true });
    expect(tk.tool("railpay_fetch")!.description).toContain("the user approves each payment");
    expect(await tk.run("railpay_balance", {})).toMatchObject({ ok: true, limits: { confirm_required: true } });
    expect(await mockWorld().toolkit().run("railpay_balance", {})).toMatchObject({ ok: true, limits: { confirm_required: false } });
  });
});
