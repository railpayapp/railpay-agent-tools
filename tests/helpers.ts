import { NETWORK, USDG, b64json, type PaymentRequired } from "railpay-sdk";

import { createRailPayTools, type RailPayToolsOptions } from "../src/index.js";

export const API = "https://api.test";
export const SELLER = "https://seller.test";
export const OTHER = "https://other.test";
export const PAY_TO = "0x2222222222222222222222222222222222222222";
export const TX = `0x${"ab".repeat(32)}`;
export const MAX_BODY = 200;

/** How the seller answers the paid retry. */
export type SettleMode = "settled" | "pending" | "rejected" | "network";

export type Call = { url: string; method: string; body: string; auth: string | null; signature: string | null; headers: Record<string, string> };

export type MockState = {
  /** Base units, as a string. */
  price: string;
  network: string;
  settle: SettleMode;
  /** Answer every RailPay call except /v1/config with this error. */
  apiError: { status: number; error: string; message: string } | null;
  /** Answer RailPay calls with no HTTP response at all. */
  apiDown: boolean;
  payDelayMs: number;
  agent: Record<string, unknown>;
  calls: Call[];
  signed: number;
  /** Signatures the seller has seen: a pending one settles on its next use. */
  seen: Map<string, number>;
};

export const agentFixture = () => ({
  id: "agt_1",
  name: "Researcher",
  address: "0x1111111111111111111111111111111111111111",
  created_at: 0,
  balance: 2_500_000,
  eth: "0.0001",
  spent_today: 30_000,
  policy: { per_request_max: 100_000, daily_cap: 1_000_000, allowed_hosts: [], allowed_pay_to: [], allow_a2a: true, paused: false },
});

export const required = (amount: string, network: string = NETWORK, url = `${SELLER}/data`): PaymentRequired => ({
  x402Version: 2,
  error: "payment_required",
  resource: { url, description: "Test data" },
  accepts: [{ scheme: "exact", network, amount, asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "Global Dollar", version: "1" } }],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function paywalled(req: Request, state: MockState, url: string): Response {
  const signature = req.headers.get("payment-signature");
  if (signature?.startsWith("signed-")) {
    const uses = (state.seen.get(signature) ?? 0) + 1;
    state.seen.set(signature, uses);
    const mode = state.settle === "pending" && uses > 1 ? "settled" : state.settle;
    if (mode === "network") throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    if (mode === "settled") {
      return new Response('{"answer":42}', {
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": b64json({ success: true, transaction: TX, network: NETWORK }) },
      });
    }
    const pr = { ...required(state.price, state.network, url), error: mode === "pending" ? "settlement_pending" : "invalid_payload" };
    const headers: Record<string, string> = { "PAYMENT-REQUIRED": b64json(pr) };
    if (mode === "pending") headers["PAYMENT-RESPONSE"] = b64json({ success: false, errorReason: "settlement_pending", transaction: TX, network: NETWORK });
    return Response.json(pr, { status: 402, headers });
  }
  const pr = required(state.price, state.network, url);
  return Response.json(pr, { status: 402, headers: { "PAYMENT-REQUIRED": b64json(pr) } });
}

/** A fake RailPay API plus a fake x402 seller, behind one fetch. */
export function mockWorld(init: Partial<MockState> = {}) {
  const state: MockState = {
    price: "1000",
    network: NETWORK,
    settle: "settled",
    apiError: null,
    apiDown: false,
    payDelayMs: 0,
    agent: agentFixture(),
    calls: [],
    signed: 0,
    seen: new Map(),
    ...init,
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const body = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    state.calls.push({
      url: req.url,
      method: req.method,
      body,
      auth: req.headers.get("authorization"),
      signature: req.headers.get("payment-signature"),
      headers,
    });
    if (req.url.startsWith(API)) {
      const path = req.url.slice(API.length);
      if (state.apiDown) throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
      if (state.apiError && path !== "/v1/config") return Response.json({ error: state.apiError.error, message: state.apiError.message }, { status: state.apiError.status });
      if (path === "/v1/agent/me") return Response.json({ agent: state.agent });
      if (path === "/v1/agent/pay") {
        if (state.payDelayMs) await sleep(state.payDelayMs);
        const n = ++state.signed;
        return Response.json({
          payment: `signed-${n}`,
          header: "PAYMENT-SIGNATURE",
          authorization: {},
          valid_before: Math.floor(Date.now() / 1000) + 300,
          amount: "0.001",
          spent_today: "0.031",
        });
      }
      if (path === "/v1/agent/send") return Response.json({ tx_hash: TX, tx_url: `https://robinhoodchain.blockscout.com/tx/${TX}`, amount: JSON.parse(body).amount });
      if (path === "/v1/config") return Response.json({ chain_id: 4663, network: NETWORK, asset: USDG });
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    }
    if (req.url === `${SELLER}/data`) return paywalled(req, state, req.url);
    if (req.url === `${OTHER}/data`) return paywalled(req, state, req.url);
    if (req.url === `${SELLER}/free`) return new Response("hello", { headers: { "content-type": "text/plain" } });
    if (req.url === `${SELLER}/big`) return new Response("x".repeat(MAX_BODY * 3), { headers: { "content-type": "text/plain" } });
    if (req.url === `${SELLER}/huge`) return new Response("y".repeat(MAX_BODY * 50), { headers: { "content-type": "text/plain" } });
    if (req.url === `${SELLER}/image`) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png", "content-length": "4" } });
    if (req.url === `${SELLER}/moved`) return new Response(null, { status: 302, headers: { location: "/data" } });
    if (req.url === `${SELLER}/echo`) return Response.json({ method: req.method, body });
    return new Response("not found", { status: 404 });
  };

  const toolkit = (options: RailPayToolsOptions = {}) =>
    createRailPayTools({ apiKey: "rp_sk_test", baseUrl: API, fetch: fetch as typeof globalThis.fetch, maxBodyChars: MAX_BODY, ...options });

  const apiCalls = (path: string) => state.calls.filter((c) => c.url === `${API}${path}`);

  return { state, fetch: fetch as typeof globalThis.fetch, toolkit, apiCalls };
}
