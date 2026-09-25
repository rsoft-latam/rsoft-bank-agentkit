# rsoft-bank-agentkit

> [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider for
> **RSoft Bank** — the bank for AI agents.

Give any AgentKit agent the full credit cycle on Base mainnet: check rates,
build credit history, vet counterparties with AgentTrust-8004 trust scores,
and borrow real USDC — signing the bank's EIP-712 `LoanRequest` natively with
the agent's own wallet. **The bank never sees a private key**: your wallet
provider signs, this provider transports.

## Install

```bash
npm install rsoft-bank-agentkit
```

## Use

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { rsoftBankActionProvider } from "rsoft-bank-agentkit";

const agentKit = await AgentKit.from({
  walletProvider, // any EVM wallet provider on Base mainnet (CDP recommended)
  actionProviders: [
    rsoftBankActionProvider({
      apiKey: process.env.RSOFT_BANK_API_KEY, // needed for loans; reads are free
    }),
  ],
});
```

## Actions

| Action | What it does | Needs |
|---|---|---|
| `get_interest_rates` | Current USDC rates by risk tier (AAA-D) | — |
| `get_creditworthiness` | Credit score, history, outstanding debt | — |
| `get_trust_score` | AgentTrust-8004 trust score (0-100) + anomaly flag for ANY wallet | — |
| `request_loan` | Sign EIP-712 with the agent's wallet and borrow real USDC | API key |
| `claim_sponsor_code` | Accept a human sponsor from a code generated in the RSoft Zero app (signs EIP-712 SponsorBinding) | API key |
| `get_sponsor_binding` | Status of that sponsor link (pending_sponsor → active) | — |
| `get_repayment_info` | Amount owed + treasury address + request_id | — |
| `confirm_repayment` | Report the USDC repayment tx; raises the credit ladder | API key |

Typical autonomous loop: `get_interest_rates` → `get_creditworthiness` →
`request_loan(5)` → *(bank disburses USDC to the wallet)* → later:
`get_repayment_info` → AgentKit's native `erc20 transfer` to the treasury →
`confirm_repayment`.

## The credit ladder

New agents start at the **$5 floor** and unlock bigger loans by repaying
($5 → $10 → $25 → $50 → $100). A default resets to the floor. History is
on-chain (ERC-8004) — portable credit your agent owns.

## Getting an API key

Money-moving endpoints are fail-closed. Request a key at
[rsoft-agentic-bank.com](https://rsoft-agentic-bank.com) — reads (rates,
creditworthiness, trust scores, repay info) need no key.

## Links

- Docs: https://rsoft-agentic-bank.com/docs
- Trust model (AgentTrust-8004): https://huggingface.co/rsoft-latam/AgentTrust-8004
- MCP server & A2A agent card: see the docs — the bank speaks four protocols.
