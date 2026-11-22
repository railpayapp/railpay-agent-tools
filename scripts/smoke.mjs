// Read-only check against the live RailPay dapp. Spends nothing: no agent key is used or read.
// Run after `pnpm build`: node scripts/smoke.mjs  (RAILPAY_BASE_URL overrides the dapp URL)
import { DEFAULT_BASE_URL, RailPay } from "railpay-sdk";

import { createRailPayTools } from "../dist/index.js";

const base = (process.env.RAILPAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

console.log(`railpay-agent-tools smoke test against ${base} (read-only, no key)\n`);

const config = await new RailPay({ baseUrl: base }).config();
const asset = config.asset && typeof config.asset === "object" ? config.asset : {};
check(
  "GET /v1/config",
  config.chain_id === 4663 && config.network === "eip155:4663" && asset.symbol === "USDG",
  `${config.chain_name ?? "chain"} ${config.chain_id}, ${config.network}, ${asset.symbol} ${asset.address}`,
);
if (Array.isArray(config.facilitators)) console.log(`     facilitators: ${config.facilitators.join(", ")}`);

// No apiKey: the toolkit cannot sign anything.
const toolkit = createRailPayTools({ baseUrl: base });

const quote = await toolkit.run("railpay_quote", { url: `${base}/x402/time` });
check(
  "railpay_quote /x402/time",
  quote.ok && quote.payable === true && quote.price_usdg === "0.001" && quote.network === "eip155:4663",
  quote.ok ? `${quote.price_usdg} USDG to ${quote.pay_to}, within limits: ${quote.within_limits}` : JSON.stringify(quote.error),
);
console.log(`     ${JSON.stringify(quote)}`);

const balance = await toolkit.run("railpay_balance", {});
check("railpay_balance without a key is refused", !balance.ok && balance.error.code === "missing_agent_key", balance.ok ? "unexpected success" : balance.error.code);

const fetched = await toolkit.run("railpay_fetch", { url: `${base}/x402/time` });
check("railpay_fetch without a key is refused before any request", !fetched.ok && fetched.error.code === "missing_agent_key", fetched.ok ? "unexpected success" : fetched.error.code);

const sent = await toolkit.run("railpay_send", { to: "agt_smoke", amount: "0.001" });
check("railpay_send is off by default", !sent.ok && sent.error.code === "send_disabled", sent.ok ? "unexpected success" : sent.error.code);

check("nothing spent", toolkit.session().spent_usdg === "0", `${toolkit.session().spent_usdg} USDG`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
