/**
 * RSoft Bank action provider for Coinbase AgentKit.
 *
 * Gives any AgentKit agent the full RSoft Bank credit cycle on Base mainnet:
 * check rates and credit history, vet counterparties with AgentTrust-8004
 * trust scores, and request real USDC loans — signing the bank's EIP-712
 * LoanRequest struct natively with the agent's own wallet provider. The
 * bank never sees a private key: the wallet signs, the provider transports.
 */

import {
  ActionProvider,
  CreateAction,
  EvmWalletProvider,
  Network,
} from "@coinbase/agentkit";
import { randomBytes } from "crypto";
import { z } from "zod";

const DEFAULT_BASE_URL = "https://rsoft-agentic-bank.com/api/v1";
const DEFAULT_TRUST_URL =
  "https://7pdor5bjoty7gyat56u6fgcrue0gbvnd.lambda-url.us-east-1.on.aws";

// EIP-712 domain + struct — MUST match the bank's on-chain verifier exactly.
const CHAIN_ID = 8453;
const VERIFYING_CONTRACT = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const LOAN_REQUEST_TYPES = {
  LoanRequest: [
    { name: "agentWallet", type: "address" },
    { name: "loanAmountUsdc6", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface RsoftBankActionProviderConfig {
  /** Bank API key — required for request_loan / confirm_repayment (money
   * POSTs are fail-closed). Reads work without it. */
  apiKey?: string;
  /** Override the bank API base URL (default: production). */
  baseUrl?: string;
  /** Override the RSoft Trust API base URL (default: production). */
  trustApiUrl?: string;
}

const WalletArgSchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional()
    .describe("EVM wallet address to query; defaults to the agent's own wallet"),
});

const RequestLoanSchema = z.object({
  amount: z
    .number()
    .positive()
    .describe(
      "Loan amount in USDC. New agents start at the $5 floor and unlock larger loans by repaying (credit ladder).",
    ),
});

const ConfirmRepaymentSchema = z.object({
  requestId: z.string().describe("Loan request id (req_...) being repaid"),
  txHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .describe("Hash of the on-chain USDC transfer to the bank treasury"),
});

const TrustScoreSchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("EVM wallet address of the agent to score"),
});

export class RsoftBankActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly baseUrl: string;
  private readonly trustUrl: string;
  private readonly apiKey?: string;

  constructor(config: RsoftBankActionProviderConfig = {}) {
    super("rsoft-bank", []);
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.trustUrl = (config.trustApiUrl ?? DEFAULT_TRUST_URL).replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  // The bank lends on Base mainnet only.
  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" &&
    (network.chainId === String(CHAIN_ID) || network.networkId === "base-mainnet");

  private async get(path: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return this.render(res);
  }

  private async post(path: string, body: unknown): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return this.render(res);
  }

  private async render(res: Response): Promise<string> {
    const text = await res.text();
    if (!res.ok) return `Bank API error ${res.status}: ${text.slice(0, 400)}`;
    return text;
  }

  @CreateAction({
    name: "get_interest_rates",
    description:
      "Get RSoft Bank's current USDC lending rates and terms on Base mainnet, by risk tier (AAA to D). Use before requesting a loan.",
    schema: z.object({}),
  })
  async getInterestRates(): Promise<string> {
    return this.get("/interest-rates");
  }

  @CreateAction({
    name: "get_creditworthiness",
    description:
      "Credit score, loan history and outstanding debt of an agent at RSoft Bank. Defaults to the agent's own wallet. Use to know what the credit ladder will allow before borrowing.",
    schema: WalletArgSchema,
  })
  async getCreditworthiness(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof WalletArgSchema>,
  ): Promise<string> {
    const wallet = args.wallet ?? walletProvider.getAddress();
    return this.get(`/agents/${wallet}/creditworthiness`);
  }

  @CreateAction({
    name: "get_trust_score",
    description:
      "On-chain trust score (0-100) of ANY agent wallet, from AgentTrust-8004 (model trained on the real ERC-8004 Base mainnet census). Includes an anomaly flag for incoherent profiles like reputation farming. Use to vet a counterparty before trading, lending or collaborating.",
    schema: TrustScoreSchema,
  })
  async getTrustScore(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof TrustScoreSchema>,
  ): Promise<string> {
    const res = await fetch(`${this.trustUrl}/score/${args.wallet}`);
    const text = await res.text();
    if (!res.ok) return `Trust API error ${res.status}: ${text.slice(0, 400)}`;
    return text;
  }

  @CreateAction({
    name: "request_loan",
    description:
      "Request a real USDC loan from RSoft Bank on Base mainnet. Signs the bank's EIP-712 LoanRequest struct with the agent's own wallet (the bank never originates unsigned loans) and submits it. On approval the bank disburses USDC to this wallet. Requires the provider to be configured with a bank API key.",
    schema: RequestLoanSchema,
  })
  async requestLoan(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RequestLoanSchema>,
  ): Promise<string> {
    if (!this.apiKey) {
      return (
        "RSoft Bank API key not configured. Loan origination is fail-closed: " +
        "construct rsoftBankActionProvider({ apiKey }) with a key issued by the bank."
      );
    }
    const agentWallet = walletProvider.getAddress();
    const nonce = "agentkit-" + randomBytes(8).toString("hex");
    const deadline = Math.floor(Date.now() / 1000) + 900;

    const signature = await walletProvider.signTypedData({
      domain: {
        name: "RSoft Agentic Bank",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: VERIFYING_CONTRACT,
      },
      types: LOAN_REQUEST_TYPES,
      primaryType: "LoanRequest",
      message: {
        agentWallet,
        loanAmountUsdc6: BigInt(Math.round(args.amount * 1e6)),
        nonce,
        deadline: BigInt(deadline),
      },
    });

    return this.post("/loan/request", {
      agent_wallet: agentWallet,
      loan_amount: args.amount,
      nonce,
      deadline,
      signature,
    });
  }

  @CreateAction({
    name: "get_repayment_info",
    description:
      "What the agent owes RSoft Bank (principal + interest), the treasury address to pay, the USDC contract and the request_id needed to confirm. Use before repaying.",
    schema: WalletArgSchema,
  })
  async getRepaymentInfo(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof WalletArgSchema>,
  ): Promise<string> {
    const wallet = args.wallet ?? walletProvider.getAddress();
    return this.get(`/loan/repay-info/${wallet}`);
  }

  @CreateAction({
    name: "confirm_repayment",
    description:
      "After transferring the exact USDC amount on-chain to the bank treasury (use the erc20 transfer action with the details from get_repayment_info), report the tx hash so the bank verifies it on Base and marks the loan repaid — which raises the agent's credit ladder.",
    schema: ConfirmRepaymentSchema,
  })
  async confirmRepayment(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof ConfirmRepaymentSchema>,
  ): Promise<string> {
    return this.post("/loan/repay", {
      request_id: args.requestId,
      tx_hash: args.txHash,
    });
  }
}

export const rsoftBankActionProvider = (config: RsoftBankActionProviderConfig = {}) =>
  new RsoftBankActionProvider(config);
