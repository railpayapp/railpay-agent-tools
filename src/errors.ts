/** Where a refusal or failure came from, so the model (and you) can tell a local limit from a server answer. */
export type ErrorSource =
  /** This library's spending guard: maxPerCall, sessionBudget, allowedHosts, send switched off. */
  | "guard"
  /** Your confirm() callback said no. */
  | "user"
  /** The agent's policy on RailPay (set by the owner in the dapp). */
  | "policy"
  /** Another answer from the RailPay API. */
  | "railpay"
  /** The tool input is invalid. */
  | "input"
  /** The request did not get an answer (DNS, connection, timeout). */
  | "network"
  /** Setup problem: missing or rejected agent key. */
  | "config"
  | "internal";

export type ToolError = {
  code: string;
  message: string;
  source: ErrorSource;
  /** True when the same call may work if made again later. */
  retryable: boolean;
  /** What to do next, written for the model. */
  hint: string;
};

/** A refusal raised inside a tool. The toolkit turns it into a structured result; it never reaches your code. */
export class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly source: ErrorSource,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ToolRefusal";
  }
}

/** The policy codes RailPay answers with when it blocks an agent payment (403, and 400 for gas). */
export const POLICY_CODES = [
  "paused",
  "a2a_not_allowed",
  "over_per_request",
  "host_not_allowed",
  "pay_to_not_allowed",
  "over_daily_cap",
  "insufficient_funds",
  "insufficient_gas",
] as const;

export type PolicyCode = (typeof POLICY_CODES)[number];

const HINTS: Record<string, string> = {
  // Agent policy, set by the owner in the RailPay dapp.
  paused: "The owner paused this agent in the RailPay dapp. Do not retry. Tell the user.",
  a2a_not_allowed: "Agent-to-agent payments are switched off in this agent's policy. Do not retry. Tell the user.",
  over_per_request: "The price is above the agent's per-request maximum set by the owner. Do not retry. Tell the user the price.",
  host_not_allowed: "This host is not on the allowlist. Do not retry. Tell the user which host you wanted to use.",
  pay_to_not_allowed: "The seller's address is not on the agent's pay-to allowlist. Do not retry. Tell the user.",
  over_daily_cap: "The agent's daily spending cap is reached. It resets at 00:00 UTC. Do not retry today. Tell the user.",
  insufficient_funds: "The agent wallet does not hold enough USDG. Tell the user it needs a top-up.",
  insufficient_gas: "The agent wallet needs a little ETH on Robinhood Chain for gas. Tell the user.",
  // Local guard and user.
  over_max_amount: "The price is above the per-call limit for this session. Do not retry. Tell the user the price and ask before going further.",
  over_session_budget: "This session's spending budget is used up. Do not retry. Tell the user how much was spent.",
  payment_declined: "The user declined this payment. Do not retry it unless the user asks.",
  send_disabled: "Sending USDG to other agents is switched off for this assistant. Do not retry.",
  // Setup.
  missing_agent_key: "No RailPay agent key is configured. Tell the user to create an agent in the RailPay dapp and pass its key.",
  unauthorized: "The RailPay agent key was rejected (wrong or revoked). Tell the user.",
  agent_key_required: "This needs an agent key (rp_sk_… of an agent), not an account key. Tell the user.",
  // Transient.
  agent_busy: "The agent is finishing another payment. Wait a few seconds and retry once.",
  rate_limited: "Too many requests. Wait a little and retry once.",
  chain_error: "Robinhood Chain did not accept the transaction right now. Retry once later.",
  network_error: "The request got no answer. Check the URL, then retry once.",
  timeout: "The request took too long and was stopped. Retry once, or tell the user.",
  // Requests.
  unsupported_requirement: "The seller asks for a payment RailPay cannot make. Do not retry. Tell the user.",
  unknown_recipient: "No RailPay agent has this id. Check the agt_… id with the user.",
  self_transfer: "An agent cannot pay itself.",
  invalid_recipient: "The recipient must be a RailPay agent id (agt_…).",
  invalid_amount: "The amount must be a positive USDG decimal string, e.g. \"0.01\".",
  invalid_input: "Fix the input and call the tool again.",
  invalid_url: "Use an absolute http(s) URL.",
  payment_already_used: "That payment already settled and its response was returned. Do not retry it.",
  payment_expired: "That signed payment expired before it settled, so it was not charged. Ask the user before paying again.",
  unknown_tool: "Use one of the tools you were given.",
};

const DEFAULT_HINT: Record<ErrorSource, string> = {
  guard: "Do not retry. Tell the user.",
  user: "Do not retry unless the user asks.",
  policy: "Do not retry. Tell the user.",
  railpay: "Tell the user what happened.",
  input: "Fix the input and call the tool again.",
  network: "Retry once, or tell the user.",
  config: "Tell the user; this needs a setup change.",
  internal: "Tell the user what happened.",
};

const INPUT_CODES = new Set(["unknown_recipient", "self_transfer", "invalid_recipient", "invalid_amount", "invalid_input", "invalid_url"]);
const CONFIG_CODES = new Set(["unauthorized", "agent_key_required", "missing_agent_key", "forbidden"]);

export function hintFor(code: string, source: ErrorSource): string {
  return HINTS[code] ?? DEFAULT_HINT[source];
}

export function toolError(code: string, message: string, source: ErrorSource, retryable = false): ToolError {
  return { code, message, source, retryable, hint: hintFor(code, source) };
}

type RailPayErrorLike = { name: string; status: number; code: string; message: string };

/** Structural check, so a second copy of railpay-sdk in node_modules is still recognised. */
function isRailPayError(e: unknown): e is RailPayErrorLike {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<RailPayErrorLike>;
  return x.name === "RailPayError" && typeof x.status === "number" && typeof x.code === "string";
}

/** Turn anything a tool threw into a {@link ToolError}. */
export function toToolError(e: unknown): ToolError {
  if (e instanceof ToolRefusal) return toolError(e.code, e.message, e.source, e.retryable);
  if (isRailPayError(e)) {
    const { status, message } = e;
    // Local refusals from the SDK carry status 0.
    if (status === 0) {
      if (e.code === "missing_api_key") return toolError("missing_agent_key", "No RailPay agent key is configured", "config");
      return toolError(e.code, message, "guard");
    }
    if ((POLICY_CODES as readonly string[]).includes(e.code)) return toolError(e.code, message, "policy");
    if (status === 429) return toolError("rate_limited", message, "railpay", true);
    if (CONFIG_CODES.has(e.code) || status === 401) return toolError(e.code === `http_${status}` ? "unauthorized" : e.code, message, "config");
    if (e.code === "agent_busy" || e.code === "chain_error" || status >= 500) return toolError(e.code, message, "railpay", true);
    if (INPUT_CODES.has(e.code)) return toolError(e.code, message, "input");
    return toolError(e.code, message, "railpay");
  }
  if (e instanceof RangeError) return toolError("invalid_amount", e.message, "input");
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return toolError("timeout", e.name === "AbortError" ? "The request was aborted" : "The request timed out", "network", e.name === "TimeoutError");
  }
  // fetch() rejects with a TypeError when there is no HTTP answer at all ("fetch failed" in Node, with a cause).
  if (e instanceof TypeError && (e.cause !== undefined || /fetch|network|load failed/i.test(e.message))) {
    return toolError("network_error", e.message, "network", true);
  }
  return toolError("internal_error", e instanceof Error ? e.message : String(e), "internal");
}
