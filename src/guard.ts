import { fromUnits, toUnits, txUrl } from "railpay-sdk";

import { ToolRefusal } from "./errors.js";

/** Default ceiling per payment, in USDG (the same default as railpay-mcp). */
export const DEFAULT_MAX_PER_CALL = "0.1";

/**
 * - `settled`: the seller (or RailPay, for a send) confirmed the transfer on-chain.
 * - `pending`: the transfer was broadcast and is still confirming.
 * - `unconfirmed`: the payment was signed and handed to the seller, without a confirmation in the answer.
 * - `unknown`: the request got no answer after the payment was made or signed. Check the explorer.
 */
export type PaymentStatus = "settled" | "pending" | "unconfirmed" | "unknown";

/** A payment that went out. Every status counts against the session budget. */
export type PaymentInfo = {
  status: PaymentStatus;
  amount_usdg: string;
  /** Seller address (0x…) for railpay_fetch, agent id (agt_…) for railpay_send. */
  pay_to: string;
  tx_hash: string | null;
  tx_url: string | null;
};

export type GuardOptions = {
  /** Ceiling per payment, in USDG. Default "0.1". */
  maxPerCall?: string | number;
  /** Total the tools may spend in this session (this toolkit instance), in USDG. Default: no session budget. */
  sessionBudget?: string | number;
  /**
   * Hosts the tools may talk to (`api.example.com`, or `host:port`), compared exactly like RailPay's own allowlist.
   * When set, railpay_quote and railpay_fetch refuse any other host before making a request. Default: any host.
   */
  allowedHosts?: readonly string[];
};

export type SessionSummary = {
  spent_usdg: string;
  /** Held by payments in flight (being signed). */
  reserved_usdg: string;
  budget_usdg: string | null;
  remaining_usdg: string | null;
};

/** A hold on part of the session budget while one payment is in flight. */
export type Reservation = {
  readonly amount: bigint;
  /** The payment went out: record it and count it as spent. */
  commit(result: { status: PaymentStatus; tx_hash?: string | null }): PaymentInfo;
  /** Nothing was signed or sent: give the amount back. */
  release(): void;
};

function parseAmount(value: string | number, name: string): bigint {
  try {
    return toUnits(value);
  } catch {
    throw new Error(`${name} must be a USDG amount like "0.1", got ${JSON.stringify(value)}`);
  }
}

function normalizeHosts(hosts: readonly string[]): string[] {
  if (hosts.length === 0) throw new Error("allowedHosts is empty. Leave it out to allow any host.");
  return [
    ...new Set(
      hosts.map((h) => {
        const host = String(h).trim().toLowerCase();
        if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) throw new Error(`allowedHosts entries are host names like "api.example.com", got ${JSON.stringify(h)}`);
        return host;
      }),
    ),
  ];
}

/**
 * Local spending limits, checked before RailPay is asked to sign anything.
 * They sit on top of the agent's server-side policy: both have to pass.
 * The checks and the hold on the budget happen synchronously, so parallel tool calls cannot overspend.
 */
export class SpendingGuard {
  readonly maxPerCall: bigint;
  readonly sessionBudget: bigint | null;
  readonly allowedHosts: readonly string[] | null;
  #spent = 0n;
  #reserved = 0n;

  constructor(options: GuardOptions = {}) {
    this.maxPerCall = parseAmount(options.maxPerCall ?? DEFAULT_MAX_PER_CALL, "maxPerCall");
    this.sessionBudget = options.sessionBudget === undefined ? null : parseAmount(options.sessionBudget, "sessionBudget");
    this.allowedHosts = options.allowedHosts ? normalizeHosts(options.allowedHosts) : null;
  }

  hostAllowed(url: URL): boolean {
    return this.allowedHosts === null || this.allowedHosts.includes(url.host.toLowerCase());
  }

  /** Throws a refusal when the URL's host is not in allowedHosts. */
  checkHost(url: URL): void {
    if (!this.hostAllowed(url)) {
      throw new ToolRefusal("host_not_allowed", `${url.host} is not in this session's allowed hosts (${this.allowedHosts!.join(", ")})`, "guard");
    }
  }

  /** The per-call ceiling, lowered by a max_amount the model asked for. A model can never raise it. */
  limitFor(maxAmount?: bigint): bigint {
    return maxAmount !== undefined && maxAmount < this.maxPerCall ? maxAmount : this.maxPerCall;
  }

  /** Budget left in this session, or null without a session budget. */
  remaining(): bigint | null {
    if (this.sessionBudget === null) return null;
    const left = this.sessionBudget - this.#spent - this.#reserved;
    return left > 0n ? left : 0n;
  }

  /** Which local limit `amount` would break, without holding anything. */
  evaluate(amount: bigint, limit = this.maxPerCall): "over_max_amount" | "over_session_budget" | null {
    if (amount > limit) return "over_max_amount";
    const left = this.remaining();
    if (left !== null && amount > left) return "over_session_budget";
    return null;
  }

  /**
   * Check the limits and hold the amount. Throws a refusal when a limit says no.
   * The caller must commit() or release() the returned reservation.
   */
  async authorize(p: { amount: bigint; payTo: string; limit?: bigint }): Promise<Reservation> {
    const limit = p.limit ?? this.maxPerCall;
    const broken = this.evaluate(p.amount, limit);
    if (broken === "over_max_amount") {
      throw new ToolRefusal("over_max_amount", `This costs ${fromUnits(p.amount)} USDG, above the per-call limit of ${fromUnits(limit)} USDG`, "guard");
    }
    if (broken === "over_session_budget") {
      throw new ToolRefusal(
        "over_session_budget",
        `This costs ${fromUnits(p.amount)} USDG and the session budget has ${fromUnits(this.remaining() ?? 0n)} USDG left of ${fromUnits(this.sessionBudget ?? 0n)} USDG`,
        "guard",
      );
    }
    this.#reserved += p.amount;
    let open = true;
    const close = () => {
      if (!open) return false;
      open = false;
      this.#reserved -= p.amount;
      return true;
    };
    const reservation: Reservation = {
      amount: p.amount,
      commit: ({ status, tx_hash }) => {
        if (!close()) throw new Error("This reservation is already closed");
        this.#spent += p.amount;
        const hash = tx_hash || null;
        return { status, amount_usdg: fromUnits(p.amount), pay_to: p.payTo, tx_hash: hash, tx_url: hash ? txUrl(hash) : null };
      },
      release: () => {
        close();
      },
    };
    return reservation;
  }

  session(): SessionSummary {
    const left = this.remaining();
    return {
      spent_usdg: fromUnits(this.#spent),
      reserved_usdg: fromUnits(this.#reserved),
      budget_usdg: this.sessionBudget === null ? null : fromUnits(this.sessionBudget),
      remaining_usdg: left === null ? null : fromUnits(left),
    };
  }
}
