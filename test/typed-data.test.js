// The CDP wallet provider (the one the README recommends) serialises the
// EIP-712 payload to JSON before signing. A BigInt anywhere in `message`
// throws "Do not know how to serialize a BigInt" and the loan never gets
// signed. These tests invoke the actions the way an agent does (through
// getActions) with a wallet that behaves like CDP's.
//
// Run: npm test   (builds first; tests exercise dist/)

const test = require("node:test");
const assert = require("node:assert/strict");
const { RsoftBankActionProvider } = require("../dist");

const AGENT = "0x" + "ab".repeat(20);
const SIG = "0x" + "11".repeat(65);
const BANK = "http://bank.invalid/api/v1";

// viem is what AgentKit hashes typed data with; use the same copy.
const viem = require(require.resolve("viem", { paths: [require.resolve("@coinbase/agentkit")] }));

function cdpLikeWallet(seen) {
  return {
    getName: () => "cdp_evm_wallet_provider",
    getAddress: () => AGENT,
    getNetwork: () => ({ protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" }),
    async signTypedData(typedData) {
      JSON.stringify(typedData); // what the CDP SDK (axios) does — throws on BigInt
      seen.push(typedData);
      return SIG;
    },
  };
}

// Every outbound request (bank + AgentKit analytics) lands here; only the
// bank's are recorded.
const posted = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(BANK)) posted.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ request_id: "req_test", status: "approved" }), { status: 200 });
};

async function invoke(name, wallet, args) {
  const provider = new RsoftBankActionProvider({ apiKey: "k", baseUrl: BANK });
  const action = provider.getActions(wallet).find((a) => a.name.endsWith(`_${name}`));
  assert.ok(action, `action ${name} is registered`);
  return action.invoke(args);
}

test("request_loan signs with a CDP-like wallet (no BigInt in typed data)", async () => {
  const signed = [];
  posted.length = 0;
  const out = await invoke("request_loan", cdpLikeWallet(signed), { amount: 5 });
  assert.match(out, /req_test/);
  assert.equal(signed.length, 1);
  const { message } = signed[0];
  assert.equal(message.loanAmountUsdc6, 5_000_000);
  assert.equal(typeof message.deadline, "number");
  // The body the bank verifies carries the same amount / nonce / deadline.
  assert.equal(posted[0].url, `${BANK}/loan/request`);
  assert.equal(posted[0].body.loan_amount, 5);
  assert.equal(posted[0].body.nonce, message.nonce);
  assert.equal(posted[0].body.deadline, message.deadline);
  assert.equal(posted[0].body.signature, SIG);
});

test("claim_sponsor_code signs with a CDP-like wallet", async () => {
  const signed = [];
  await invoke("claim_sponsor_code", cdpLikeWallet(signed), { code: "abc-def" });
  assert.equal(signed.length, 1);
  assert.equal(signed[0].message.sponsorRef, "pair:ABCDEF");
  assert.equal(typeof signed[0].message.deadline, "number");
});

test("sub-cent amounts are rounded to 6 decimals before signing AND sending", async () => {
  const signed = [];
  posted.length = 0;
  await invoke("request_loan", cdpLikeWallet(signed), { amount: 5.0000005 });
  const usdc6 = signed[0].message.loanAmountUsdc6;
  // Whatever JS rounds to, the body carries that exact 6-decimal amount, so
  // Python's int(round(loan_amount * 1e6)) reproduces it.
  assert.equal(usdc6, 5_000_001);
  assert.equal(posted[0].body.loan_amount, 5.000001);
  assert.equal(Math.round(posted[0].body.loan_amount * 1e6), usdc6);
});

test("number and BigInt uint256 values hash to the same EIP-712 digest", async () => {
  const signed = [];
  await invoke("request_loan", cdpLikeWallet(signed), { amount: 12.34 });
  const td = signed[0];
  const asBigInt = {
    ...td,
    message: {
      ...td.message,
      loanAmountUsdc6: BigInt(td.message.loanAmountUsdc6),
      deadline: BigInt(td.message.deadline),
    },
  };
  assert.equal(viem.hashTypedData(td), viem.hashTypedData(asBigInt));
});
