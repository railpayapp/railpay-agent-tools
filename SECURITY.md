# Security

Please report vulnerabilities privately to **founder@railpay.app**. Do not open a public issue.

Include what you found, how to reproduce it and what it affects. We will reply within a few days.

In scope: this library, in particular anything that lets a tool call spend above `maxPerCall`, `sessionBudget` or the agent's policy, pay a host outside `allowedHosts`, pay twice for one call, run `railpay_send` while it is switched off, or leak the agent key into a tool result.
