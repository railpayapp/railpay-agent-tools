import {
  RailPay,
  addressUrl,
  fromUnits,
  isRailPayPayable,
  readPaymentRequired,
  readPaymentResponse,
  requirementAmount,
  toUnits,
  withPayment,
  type PaymentRequired,
  type SignedPayment,
} from "railpay-sdk";

import { ToolRefusal, toToolError, toolError, type ToolError } from "./errors.js";
import { SpendingGuard, type GuardOptions, type PaymentInfo, type PaymentStatus, type Reservation, type SessionSummary } from "./guard.js";
import { USDG_PATTERN, validate, type ObjectSchema } from "./schema.js";

export type ToolName = "railpay_balance" | "railpay_quote" | "railpay_fetch" | "railpay_send";

export const TOOL_NAMES: readonly ToolName[] = ["railpay_balance", "railpay_quote", "railpay_fetch", "railpay_send"];

/** A refusal or failure, as the model sees it. Tools return this instead of throwing. */
export type ToolFailure = {
  ok: false;
  error: ToolError;
  /** Set when money may have moved before the failure (signed, or sent without an answer). */
  payment?: PaymentInfo;
};

export type ToolSuccess<T extends object = Record<string, unknown>> = { ok: true } & T;

/** Every tool resolves to one of these. All values are JSON-safe (amounts are decimal strings). */
export type ToolResult<T extends object = Record<string, unknown>> = ToolSuccess<T> | ToolFailure;

export type ToolContext = {
  /** Aborts the HTTP requests of this call (framework abort signals are passed through here). */
  signal?: AbortSignal;
};

/** A framework-neutral tool. The adapters turn these into Vercel AI SDK, OpenAI, Anthropic or LangChain tools. */
export type RailPayTool = {
  name: ToolName;
  title: string;
  /** Written for the model. Ends with this session's limits. */
  description: string;
  inputSchema: ObjectSchema;
  /** True for the tools that can move money. */
  spends: boolean;
  /** Validates the input, runs the tool and never throws. */
  execute(input: unknown, context?: ToolContext): Promise<ToolResult>;
};

/** The RailPay client methods the tools use. A `RailPay` instance from railpay-sdk fits. */
export type RailPayClient = Pick<RailPay, "me" | "pay" | "send">;

export type RailPayToolsOptions = GuardOptions & {
  /** Agent key (`rp_sk_…`) from the RailPay dapp. Not read from the environment: pass it explicitly. */
  apiKey?: string;
  /** A ready RailPay client (railpay-sdk `RailPay`), instead of apiKey / baseUrl. */
  client?: RailPayClient;
  /** RailPay API. Default https://dapp.railpay.app. */
  baseUrl?: string;
  /** fetch used for RailPay and for the URLs the agent requests. Default: global fetch. */
  fetch?: typeof fetch;
  /** Add railpay_send (agent-to-agent USDG). Default false: the tool is not offered and refuses if called. */
  allowSend?: boolean;
  /** Response bodies are cut at this many characters. Default 20,000 (as railpay-mcp). */
  maxBodyChars?: number;
  /** Timeout per HTTP request made for a tool call, in milliseconds. Default 60,000. */
  timeoutMs?: number;
};

export type RailPayToolkit = {
  /** The tools to give the model. railpay_send is only here with allowSend. */
  tools: RailPayTool[];
  tool(name: ToolName): RailPayTool | undefined;
  /** True for every name this toolkit answers for, including railpay_send when it is switched off. */
  has(name: string): boolean;
  /** Run a tool by name. Unknown or switched-off tools resolve to a refusal. Never throws. */
  run(name: string, input: unknown, context?: ToolContext): Promise<ToolResult>;
  session(): SessionSummary;
  guard: SpendingGuard;
  client: RailPayClient;
};

// ---------- outputs ----------

export type BalanceOutput = {
  id: string;
  name: string;
  address: string;
  balance_usdg: string;
  eth: string;
  spent_today_usdg: string;
  left_today_usdg: string;
  policy: {
    paused: boolean;
    per_request_max_usdg: string;
    daily_cap_usdg: string;
    allowed_hosts: string[];
    allowed_pay_to: string[];
    allow_a2a: boolean;
  };
  limits: {
    max_per_call_usdg: string;
    session_budget_usdg: string | null;
    session_spent_usdg: string;
    session_remaining_usdg: string | null;
    allowed_hosts: string[] | null;
    send_enabled: boolean;
    /** The most a single payment can be right now: the lowest of every limit and the balance. */
    max_payment_now_usdg: string;
  };
  explorer: string;
};

export type PaymentOption = { scheme: string; network: string; asset: string; amount: string | undefined; pay_to: string; payable_by_railpay: boolean };

export type QuoteOutput = {
  url: string;
  status: number;
  payable: boolean;
  price_usdg?: string;
  amount_units?: string;
  pay_to?: string;
  network?: string;
  asset?: string;
  scheme?: string;
  description?: string;
  max_timeout_seconds?: number;
  /** Local limits only (per-call limit and session budget). The agent's RailPay policy is checked when paying. */
  within_limits?: boolean;
  limit_reason?: "over_max_amount" | "over_session_budget";
  options?: PaymentOption[];
  redirect?: string;
  note: string;
};

export type PaidInfo = {
  status: PaymentStatus;
  amount_usdg: string;
  pay_to: string;
  settled: boolean;
  tx_hash: string | null;
  tx_url: string | null;
  note?: string;
};

export type FetchOutput = {
  status: number;
  content_type: string | null;
  body: string | null;
  truncated: boolean;
  binary?: boolean;
  bytes?: number | null;
  redirect?: string;
  paid: PaidInfo | null;
  payment_required?: PaymentOption[] | null;
  note?: string;
  session: { spent_usdg: string; budget_usdg: string | null; remaining_usdg: string | null };
};

export type SendOutput = {
  status: PaymentStatus;
  amount_usdg: string;
  to: string;
  memo?: string;
  tx_hash: string | null;
  tx_url: string | null;
  session: { spent_usdg: string; budget_usdg: string | null; remaining_usdg: string | null };
};

// ---------- schemas ----------

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const URL_FIELD = { type: "string", description: "Absolute http(s) URL.", maxLength: 2048 } as const;

const SCHEMAS: Record<ToolName, ObjectSchema> = {
  railpay_balance: { type: "object", properties: {}, additionalProperties: false },
  railpay_quote: {
    type: "object",
    properties: { url: URL_FIELD },
    required: ["url"],
    additionalProperties: false,
  },
  railpay_fetch: {
    type: "object",
    properties: {
      url: URL_FIELD,
      method: { type: "string", enum: METHODS, description: "Default GET." },
      body: { type: "string", description: "Request body for POST, PUT, PATCH or DELETE. Ignored for GET." },
      headers: { type: "object", additionalProperties: { type: "string" }, description: "Extra request headers, as name: value." },
      max_amount: {
        type: "string",
        pattern: USDG_PATTERN,
        description: 'Refuse to pay more than this, in USDG, e.g. "0.01". Can only lower the per-call limit.',
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  railpay_send: {
    type: "object",
    properties: {
      to: { type: "string", pattern: "^agt_[A-Za-z0-9_-]+$", description: "Recipient RailPay agent id, agt_…" },
      amount: { type: "string", pattern: USDG_PATTERN, description: 'Amount in USDG, e.g. "0.05".' },
      memo: { type: "string", maxLength: 140, description: "Short note stored with the payment." },
    },
    required: ["to", "amount"],
    additionalProperties: false,
  },
};

// ---------- helpers ----------

const DEFAULT_MAX_BODY_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Headers the model may not set: they carry payments, and only the toolkit attaches them. */
const RESERVED_HEADERS = new Set(["payment-signature", "x-payment"]);

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolRefusal("invalid_url", "url must be an absolute http(s) URL", "input");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolRefusal("invalid_url", "url must be an absolute http(s) URL", "input");
  return url;
}

function signalFor(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

function summarize(pr: PaymentRequired): PaymentOption[] {
  return pr.accepts.map((r) => ({
    scheme: r.scheme,
    network: r.network,
    asset: r.asset,
    amount: r.amount ?? r.maxAmountRequired,
    pay_to: r.payTo,
    payable_by_railpay: isRailPayPayable(r),
  }));
}

function redirectOf(res: Response, base: string): string | undefined {
  if (res.status < 300 || res.status > 399) return undefined;
  const location = res.headers.get("location");
  if (!location) return undefined;
  try {
    return new URL(location, base).href;
  } catch {
    return location;
  }
}

const TEXT_TYPE = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|csv|yaml|graphql/i;

/** Read at most what can be shown, so a huge answer does not end up in memory. */
async function readBody(res: Response, maxChars: number) {
  const type = res.headers.get("content-type");
  if (type && !TEXT_TYPE.test(type)) {
    await res.body?.cancel().catch(() => {});
    const length = Number(res.headers.get("content-length"));
    return { body: null, truncated: false, binary: true as const, bytes: Number.isFinite(length) && length > 0 ? length : null, text: "" };
  }
  const limit = maxChars * 4 + 4;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = true;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= limit) {
        complete = false;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (complete && text.length <= maxChars) return { body: text, truncated: false, text };
  const more = complete ? `${text.length} chars in total` : `more than ${maxChars} chars`;
  return { body: `${text.slice(0, maxChars)}\n…[truncated, ${more}]`, truncated: true, text };
}

function errorField(text: string): string | undefined {
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error;
    return typeof e === "string" ? e : undefined;
  } catch {
    return undefined;
  }
}

// ---------- toolkit ----------

/**
 * Build the RailPay payment tools for one agent session.
 * Limits (maxPerCall, sessionBudget, allowedHosts) apply to every tool call made through this toolkit.
 */
export function createRailPayTools(options: RailPayToolsOptions = {}): RailPayToolkit {
  const guard = new SpendingGuard(options);
  const baseFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const client: RailPayClient = options.client ?? new RailPay({ apiKey: options.apiKey, baseUrl: options.baseUrl, fetch: options.fetch });
  const hasKey = options.client !== undefined || !!options.apiKey;
  const allowSend = options.allowSend === true;
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const needKey = () => {
    if (!hasKey) throw new ToolRefusal("missing_agent_key", "No RailPay agent key is configured (apiKey)", "config");
  };
  const sessionShort = () => {
    const s = guard.session();
    return { spent_usdg: s.spent_usdg, budget_usdg: s.budget_usdg, remaining_usdg: s.remaining_usdg };
  };

  // ----- railpay_balance -----
  async function balance(): Promise<ToolSuccess<BalanceOutput>> {
    needKey();
    const a = await client.me();
    const left = Math.max(0, a.policy.daily_cap - a.spent_today);
    const session = guard.session();
    const remaining = guard.remaining();
    const caps = [guard.maxPerCall, BigInt(a.policy.per_request_max), BigInt(left), BigInt(Math.max(0, a.balance))];
    if (remaining !== null) caps.push(remaining);
    let now = caps.reduce((m, v) => (v < m ? v : m));
    if (a.policy.paused) now = 0n;
    return {
      ok: true,
      id: a.id,
      name: a.name,
      address: a.address,
      balance_usdg: fromUnits(a.balance),
      eth: a.eth,
      spent_today_usdg: fromUnits(a.spent_today),
      left_today_usdg: fromUnits(left),
      policy: {
        paused: a.policy.paused,
        per_request_max_usdg: fromUnits(a.policy.per_request_max),
        daily_cap_usdg: fromUnits(a.policy.daily_cap),
        allowed_hosts: a.policy.allowed_hosts,
        allowed_pay_to: a.policy.allowed_pay_to,
        allow_a2a: a.policy.allow_a2a,
      },
      limits: {
        max_per_call_usdg: fromUnits(guard.maxPerCall),
        session_budget_usdg: session.budget_usdg,
        session_spent_usdg: session.spent_usdg,
        session_remaining_usdg: session.remaining_usdg,
        allowed_hosts: guard.allowedHosts ? [...guard.allowedHosts] : null,
        send_enabled: allowSend,
        max_payment_now_usdg: fromUnits(now),
      },
      explorer: addressUrl(a.address),
    };
  }

  // ----- railpay_quote -----
  async function quote(input: { url: string }, ctx: ToolContext): Promise<ToolSuccess<QuoteOutput>> {
    const url = parseUrl(input.url);
    guard.checkHost(url);
    const res = await baseFetch(url.href, { method: "GET", redirect: "manual", signal: signalFor(timeoutMs, ctx.signal) });
    const base = { url: url.href, status: res.status };
    const redirect = redirectOf(res, url.href);
    if (res.status !== 402) {
      await res.body?.cancel().catch(() => {});
      return {
        ok: true,
        ...base,
        payable: false,
        ...(redirect ? { redirect } : {}),
        note: redirect
          ? `The URL redirects to ${redirect}. railpay_fetch does not follow redirects; quote that URL instead.`
          : `This URL did not ask for a payment (HTTP ${res.status}). railpay_fetch would not pay anything for a GET.`,
      };
    }
    const pr = await readPaymentRequired(res);
    await res.body?.cancel().catch(() => {});
    const req = pr?.accepts.find(isRailPayPayable);
    if (!pr || !req) {
      return {
        ok: true,
        ...base,
        payable: false,
        options: pr ? summarize(pr) : [],
        note: "The URL asks for a payment RailPay cannot make (only x402 exact / eip155:4663 / USDG is supported).",
      };
    }
    const amount = requirementAmount(req);
    const broken = guard.evaluate(amount);
    const price = fromUnits(amount);
    let note = `railpay_fetch would pay ${price} USDG to ${req.payTo} for a GET of this URL. The agent's RailPay policy is checked when paying.`;
    if (broken === "over_max_amount") note = `The price, ${price} USDG, is above this session's per-call limit of ${fromUnits(guard.maxPerCall)} USDG: railpay_fetch would refuse it.`;
    if (broken === "over_session_budget") note = `The price, ${price} USDG, is more than the ${fromUnits(guard.remaining() ?? 0n)} USDG left in this session's budget: railpay_fetch would refuse it.`;
    return {
      ok: true,
      ...base,
      payable: true,
      price_usdg: price,
      amount_units: amount.toString(),
      pay_to: req.payTo,
      network: req.network,
      asset: req.asset,
      scheme: req.scheme,
      ...(pr.resource?.description ? { description: pr.resource.description } : {}),
      ...(req.maxTimeoutSeconds !== undefined ? { max_timeout_seconds: req.maxTimeoutSeconds } : {}),
      within_limits: broken === null,
      ...(broken ? { limit_reason: broken } : {}),
      options: summarize(pr),
      note,
    };
  }

  // ----- railpay_fetch -----
  type FetchInput = { url: string; method?: string; body?: string; headers?: Record<string, string>; max_amount?: string };

  async function respond(res: Response, url: URL, paid: PaymentInfo | null): Promise<ToolSuccess<FetchOutput>> {
    const read = await readBody(res, maxBodyChars);
    const redirect = redirectOf(res, url.href);
    const out: ToolSuccess<FetchOutput> = {
      ok: true,
      status: res.status,
      content_type: res.headers.get("content-type"),
      body: read.body,
      truncated: read.truncated,
      ...(read.binary ? { binary: true, bytes: read.bytes } : {}),
      ...(redirect ? { redirect } : {}),
      paid: null,
      session: sessionShort(),
    };
    if (redirect) out.note = `Redirect to ${redirect}, not followed. Call railpay_fetch with that URL if you trust it.`;
    if (paid) {
      const r = paid;
      const info: PaidInfo = {
        status: r.status,
        amount_usdg: r.amount_usdg,
        pay_to: r.pay_to,
        settled: r.status === "settled",
        tx_hash: r.tx_hash,
        tx_url: r.tx_url,
      };
      const again = "Do not pay again for the same thing. Tell the user, with the transaction link.";
      if (r.status === "settled" && !res.ok) info.note = `The payment settled but the seller answered HTTP ${res.status}. Do not pay again for the same thing. Tell the user.`;
      if (r.status === "pending") info.note = `The payment was broadcast and is still confirming, so the seller has not served the resource yet. ${again}`;
      if (r.status === "unconfirmed" && res.status === 402) {
        info.note = `The seller did not accept the payment (${errorField(read.text) ?? "no reason given"}). ${again} The payment counts against the session budget.`;
      } else if (r.status === "unconfirmed") {
        info.note = "Signed and sent. The seller did not confirm settlement in this response.";
      }
      out.paid = info;
    } else if (res.status === 402) {
      const pr = await readPaymentRequired(new Response(read.text, { status: 402, headers: res.headers }));
      out.payment_required = pr ? summarize(pr) : null;
      out.note = "The resource asks for a payment RailPay cannot make (only x402 exact / eip155:4663 / USDG is supported).";
    }
    return out;
  }

  function statusOf(res: Response): { status: PaymentStatus; tx_hash: string | null } {
    const receipt = readPaymentResponse(res);
    const tx = receipt?.transaction || null;
    if (receipt?.success && tx) return { status: "settled", tx_hash: tx };
    if (tx) return { status: "pending", tx_hash: tx };
    return { status: "unconfirmed", tx_hash: null };
  }

  async function paidFetch(input: FetchInput, ctx: ToolContext): Promise<ToolResult> {
    needKey();
    const url = parseUrl(input.url);
    guard.checkHost(url);

    const limit = guard.limitFor(input.max_amount === undefined ? undefined : toUnits(input.max_amount));
    const method = input.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers ?? {})) if (!RESERVED_HEADERS.has(k.toLowerCase())) headers[k] = v;
    const body = input.body === undefined || method === "GET" ? undefined : input.body;

    type Held = { reservation: Reservation; payTo: string; payment: SignedPayment };
    // Set by the pay() wrapper below. Declared with `as` so TypeScript does not narrow it to null.
    let held = null as Held | null;
    // withPayment calls client.pay() once it has a payable 402. This wrapper runs the spending guard first
    // and asks RailPay to sign exactly the requirement that was checked.
    const guarded = Object.create(client) as RailPayClient;
    guarded.pay = async (pr: PaymentRequired, resourceUrl?: string) => {
      const req = pr.accepts.find(isRailPayPayable)!;
      const reservation = await guard.authorize({ amount: requirementAmount(req), payTo: req.payTo, limit });
      try {
        const payment = await client.pay({ ...pr, accepts: [req] }, resourceUrl);
        held = { reservation, payTo: req.payTo, payment };
        return payment;
      } catch (e) {
        reservation.release();
        throw e;
      }
    };

    // withPayment only calls pay() on the client it is given.
    const payingFetch = withPayment(guarded as unknown as RailPay, { fetch: baseFetch });
    let res: Response;
    try {
      res = await payingFetch(url.href, { method, headers, body, redirect: "manual", signal: signalFor(timeoutMs, ctx.signal) });
    } catch (e) {
      const h = held;
      if (!h) throw e;
      // Signed, then the paid retry got no answer: the seller may still settle it.
      const payment = h.reservation.commit({ status: "unknown" });
      const err = toToolError(e);
      return {
        ok: false,
        error: { ...err, hint: "The payment was signed and sent, but the request got no answer, so it may settle. Do not pay again for this. Tell the user." },
        payment,
      };
    }
    const h = held;
    if (!h) return respond(res, url, null);
    return respond(res, url, h.reservation.commit(statusOf(res)));
  }

  // ----- railpay_send -----
  async function send(input: { to: string; amount: string; memo?: string }): Promise<ToolResult> {
    needKey();
    const amount = toUnits(input.amount);
    if (amount <= 0n) throw new ToolRefusal("invalid_amount", "amount must be above 0", "input");
    const reservation = await guard.authorize({ amount, payTo: input.to });
    let r;
    try {
      r = await client.send({ to: input.to, amount: fromUnits(amount), ...(input.memo ? { memo: input.memo } : {}) });
    } catch (e) {
      const err = toToolError(e);
      if (err.source !== "network") {
        reservation.release();
        throw e;
      }
      // No answer from RailPay: the transfer may have gone out. Keep it counted.
      const payment = reservation.commit({ status: "unknown" });
      return {
        ok: false,
        error: { ...err, hint: "RailPay did not answer, so the transfer may have gone out. Do not send again. Check railpay_balance or tell the user." },
        payment,
      };
    }
    const record = reservation.commit({ status: r.pending ? "pending" : "settled", tx_hash: r.tx_hash });
    const out: ToolSuccess<SendOutput> = {
      ok: true,
      status: record.status,
      amount_usdg: record.amount_usdg,
      to: input.to,
      ...(input.memo ? { memo: input.memo } : {}),
      tx_hash: record.tx_hash,
      tx_url: r.tx_url || record.tx_url,
      session: sessionShort(),
    };
    return out;
  }

  // ----- descriptions -----
  const limitText = () => {
    const parts = [`at most ${fromUnits(guard.maxPerCall)} USDG per payment`];
    if (guard.sessionBudget !== null) parts.push(`a total budget of ${fromUnits(guard.sessionBudget)} USDG`);
    if (guard.allowedHosts) parts.push(`only these hosts: ${guard.allowedHosts.join(", ")}`);
    return ` Limits in this session: ${parts.join("; ")}.`;
  };
  const hostText = () => (guard.allowedHosts ? ` Only these hosts can be used: ${guard.allowedHosts.join(", ")}.` : "");

  const definitions: Record<ToolName, Omit<RailPayTool, "execute" | "inputSchema"> & { run: (input: never, ctx: ToolContext) => Promise<ToolResult> }> = {
    railpay_balance: {
      name: "railpay_balance",
      title: "RailPay wallet balance and limits",
      description:
        "Shows this agent's RailPay wallet on Robinhood Chain: USDG balance, ETH for gas, what it spent today, the owner's spending policy, and this session's limits, including max_payment_now_usdg, the most one payment can be right now. Spends nothing. Call it when you need to know the budget before paying.",
      spends: false,
      run: () => balance(),
    },
    railpay_quote: {
      name: "railpay_quote",
      title: "Read an x402 price",
      description:
        "Reads the x402 price of a URL without paying: makes one GET request and reports whether it asks for a payment, how much USDG, to which address, and whether railpay_fetch would pay it within this session's limits. Spends nothing. Use it first when the user cares about the price." +
        hostText(),
      spends: false,
      run: (input: { url: string }, ctx) => quote(input, ctx),
    },
    railpay_fetch: {
      name: "railpay_fetch",
      title: "Fetch a URL, paying x402 if asked",
      description:
        `Makes an HTTP request. When the server answers 402 Payment Required with x402, pays it in USDG from the agent's RailPay wallet and retries once. Spends real money. Returns the status, the body (cut at ${maxBodyChars.toLocaleString("en-US")} characters) and the payment with its settlement transaction link. Redirects are not followed. A refusal comes back as ok: false with a hint: follow the hint, do not work around it. Ask the user before paying for something they did not ask for.` +
        limitText(),
      spends: true,
      run: (input: FetchInput, ctx) => paidFetch(input, ctx),
    },
    railpay_send: {
      name: "railpay_send",
      title: "Pay another RailPay agent",
      description:
        "Sends USDG from this agent's wallet to another RailPay agent (agt_…) on Robinhood Chain. Real money that cannot be taken back. Needs agent-to-agent payments switched on by the owner and a little ETH in the agent wallet for gas. Only send when the user asked for this payment." +
        limitText(),
      spends: true,
      run: (input: { to: string; amount: string; memo?: string }) => send(input),
    },
  };

  const make = (name: ToolName): RailPayTool => {
    const d = definitions[name];
    const inputSchema = SCHEMAS[name];
    return {
      name: d.name,
      title: d.title,
      description: d.description,
      inputSchema,
      spends: d.spends,
      async execute(input: unknown, context: ToolContext = {}): Promise<ToolResult> {
        if (name === "railpay_send" && !allowSend) {
          return { ok: false, error: toolError("send_disabled", "railpay_send is switched off for this assistant (allowSend: false)", "guard") };
        }
        const value = input === undefined || input === null ? {} : input;
        const problem = validate(inputSchema, value);
        if (problem) return { ok: false, error: toolError("invalid_input", problem, "input") };
        try {
          return await d.run(value as never, context);
        } catch (e) {
          return { ok: false, error: toToolError(e) };
        }
      },
    };
  };

  const all = Object.fromEntries(TOOL_NAMES.map((n) => [n, make(n)])) as Record<ToolName, RailPayTool>;
  const tools = TOOL_NAMES.filter((n) => n !== "railpay_send" || allowSend).map((n) => all[n]);
  const has = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name);

  return {
    tools,
    tool: (name) => tools.find((t) => t.name === name),
    has,
    async run(name, input, context) {
      if (!has(name)) return { ok: false, error: toolError("unknown_tool", `There is no tool named ${JSON.stringify(name)}`, "input") };
      return all[name].execute(input, context);
    },
    session: () => guard.session(),
    guard,
    client,
  };
}

/** The JSON text adapters hand back to the model. */
export function resultText(result: ToolResult): string {
  return JSON.stringify(result);
}
