import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_PER_CALL, SpendingGuard, ToolRefusal } from "../src/index.js";

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ToolRefusal);
    return e as ToolRefusal;
  }
  throw new Error("expected a refusal");
};

describe("SpendingGuard", () => {
  it("defaults to 0.1 USDG per call, no budget, any host", () => {
    const g = new SpendingGuard();
    expect(DEFAULT_MAX_PER_CALL).toBe("0.1");
    expect(g.maxPerCall).toBe(100_000n);
    expect(g.sessionBudget).toBeNull();
    expect(g.hostAllowed(new URL("https://anything.test/x"))).toBe(true);
    expect(g.session()).toEqual({ spent_usdg: "0", reserved_usdg: "0", budget_usdg: null, remaining_usdg: null });
  });

  it("rejects bad options when it is built", () => {
    expect(() => new SpendingGuard({ maxPerCall: "lots" })).toThrow(/maxPerCall/);
    expect(() => new SpendingGuard({ sessionBudget: "-1" })).toThrow(/sessionBudget/);
    expect(() => new SpendingGuard({ allowedHosts: [] })).toThrow(/empty/);
    expect(() => new SpendingGuard({ allowedHosts: ["https://api.test"] })).toThrow(/host names/);
  });

  it("lets max_amount lower the per-call limit, never raise it", () => {
    const g = new SpendingGuard({ maxPerCall: "0.05" });
    expect(g.limitFor()).toBe(50_000n);
    expect(g.limitFor(10_000n)).toBe(10_000n);
    expect(g.limitFor(9_000_000n)).toBe(50_000n);
  });

  it("refuses a payment above the per-call cap", async () => {
    const g = new SpendingGuard({ maxPerCall: "0.01" });
    const e = await refusal(g.authorize({ tool: "railpay_fetch", amount: 20_000n, payTo: "0x2" }));
    expect(e.code).toBe("over_max_amount");
    expect(e.source).toBe("guard");
    expect(e.message).toContain("0.02 USDG");
  });

  it("holds, commits and releases against the session budget", async () => {
    const g = new SpendingGuard({ sessionBudget: "0.003" });
    const a = await g.authorize({ tool: "railpay_fetch", amount: 2_000n, payTo: "0x2" });
    expect(g.session()).toMatchObject({ reserved_usdg: "0.002", remaining_usdg: "0.001" });
    // The hold counts: a second payment cannot use the same budget.
    expect((await refusal(g.authorize({ tool: "railpay_fetch", amount: 2_000n, payTo: "0x2" }))).code).toBe("over_session_budget");
    a.release();
    expect(g.session()).toMatchObject({ reserved_usdg: "0", remaining_usdg: "0.003" });

    const b = await g.authorize({ tool: "railpay_fetch", amount: 3_000n, payTo: "0x2" });
    const info = b.commit({ status: "settled", tx_hash: `0x${"cd".repeat(32)}` });
    expect(info).toMatchObject({ status: "settled", amount_usdg: "0.003", pay_to: "0x2" });
    expect(info.tx_url).toContain("/tx/0x");
    expect(g.session()).toEqual({ spent_usdg: "0.003", reserved_usdg: "0", budget_usdg: "0.003", remaining_usdg: "0" });
    expect(() => b.commit({ status: "settled" })).toThrow(/closed/);
    b.release(); // no effect once committed
    expect(g.session().spent_usdg).toBe("0.003");
  });

  it("does not let parallel payments overspend the budget", async () => {
    const g = new SpendingGuard({ sessionBudget: "0.005" });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => g.authorize({ tool: "railpay_fetch", amount: 2_000n, payTo: "0x2" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  });

  it("matches allowed hosts exactly, port included, case-insensitive", () => {
    const g = new SpendingGuard({ allowedHosts: ["API.example.com", "localhost:8787"] });
    expect(g.hostAllowed(new URL("https://api.example.com/x"))).toBe(true);
    expect(g.hostAllowed(new URL("https://api.example.com:443/x"))).toBe(true);
    expect(g.hostAllowed(new URL("http://localhost:8787/x"))).toBe(true);
    expect(g.hostAllowed(new URL("http://localhost/x"))).toBe(false);
    expect(g.hostAllowed(new URL("https://evil.api.example.com/x"))).toBe(false);
    expect(g.hostAllowed(new URL("https://api.example.com.evil.test/x"))).toBe(false);
    expect(() => g.checkHost(new URL("https://evil.test"))).toThrow(/evil.test is not in this session's allowed hosts/);
  });

  it("reports which limit a price would break", () => {
    const g = new SpendingGuard({ maxPerCall: "0.01", sessionBudget: "0.005" });
    expect(g.evaluate(1_000n)).toBeNull();
    expect(g.evaluate(20_000n)).toBe("over_max_amount");
    expect(g.evaluate(6_000n)).toBe("over_session_budget");
  });
});
