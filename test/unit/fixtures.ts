import type { Address } from "viem";
import { SAFE7579_ADAPTER, SAFE_V141, ZERO_ADDRESS } from "../../src/core/constants";
import { knownLabels, type AccountReport } from "../../src/core/inspect";

export const ACCOUNT: Address = "0x1111111111111111111111111111111111111111";
export const OWNER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const OTHER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const PAYEE: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
export const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const ESCROW: Address = "0x7DFb13379961afBd74725562B8Ddd1498A2dEbBe";
export const STREAMS: Address = "0xfA963d2A62faB54E1aC8005Db8D9B8F3f9919Fd4";
export const VAULTS: Address = "0xdA19F78aa991ec7D236725745F65Ff2bee7d439A";
export const GUARD: Address = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
export const SPEND_KEY: Address = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
export const NOW = 1_800_000_000n;
export const USDC_UNIT = 1_000_000n;

/** A synthetic inspection report of an Agent Bank account with one of everything. */
export function makeReport(overrides: Partial<AccountReport> = {}): AccountReport {
  const contracts = { escrow: ESCROW, streams: STREAMS, vaults: VAULTS };
  const base: AccountReport = {
    chain: { id: 84532, name: "base-sepolia", label: "Base Sepolia" },
    block: { number: 48_000_000n, timestamp: NOW },
    account: ACCOUNT,
    safe: {
      address: ACCOUNT,
      deployed: true,
      version: "1.4.1",
      singleton: SAFE_V141.safeL2,
      owners: [OWNER],
      threshold: 1n,
      nonce: 7n,
      modules: [OTHER, SAFE7579_ADAPTER],
      fallbackHandler: SAFE7579_ADAPTER,
      guard: GUARD,
    },
    signer: { address: OWNER, isOwner: true },
    eth: 2n * 10n ** 18n,
    usdc: { address: USDC, symbol: "USDC", decimals: 6 },
    tokens: { [USDC.toLowerCase()]: { address: USDC, symbol: "USDC", decimals: 6 } },
    balances: { [USDC.toLowerCase()]: 100n * USDC_UNIT },
    agentBankConfigured: true,
    contracts,
    escrows: [
      {
        id: 1n,
        role: "payer",
        status: "Active",
        payer: ACCOUNT,
        payee: PAYEE,
        token: USDC,
        amount: 10n * USDC_UNIT,
        expiresAt: NOW - 10n,
        arbiter: ZERO_ADDRESS,
        validator: ZERO_ADDRESS,
        refundableAt: NOW - 10n,
        refundableNow: true,
        releasableNow: false,
      },
      {
        id: 2n,
        role: "payer",
        status: "Active",
        payer: ACCOUNT,
        payee: PAYEE,
        token: USDC,
        amount: 20n * USDC_UNIT,
        expiresAt: NOW + 1000n,
        arbiter: ZERO_ADDRESS,
        validator: ZERO_ADDRESS,
        refundableAt: NOW + 1000n,
        refundableNow: false,
        releasableNow: false,
      },
      {
        id: 3n,
        role: "payer",
        status: "Released",
        payer: ACCOUNT,
        payee: PAYEE,
        token: USDC,
        amount: 5n * USDC_UNIT,
        expiresAt: NOW - 10n,
        arbiter: ZERO_ADDRESS,
        validator: ZERO_ADDRESS,
        refundableAt: 0n,
        refundableNow: false,
        releasableNow: false,
      },
    ],
    streams: [
      {
        id: 1n,
        role: "payer",
        payer: ACCOUNT,
        payee: PAYEE,
        token: USDC,
        deposit: 100n * USDC_UNIT,
        paid: 0n,
        refunded: 0n,
        canceled: false,
        start: NOW - 100n,
        stop: 0n,
        interval: 1n,
        amountPerInterval: USDC_UNIT,
        accrued: 100n * USDC_UNIT - 40n * USDC_UNIT,
        settleable: 60n * USDC_UNIT,
        refundIfCanceled: 40n * USDC_UNIT,
      },
      {
        id: 2n,
        role: "payer",
        payer: ACCOUNT,
        payee: PAYEE,
        token: USDC,
        deposit: 10n * USDC_UNIT,
        paid: 10n * USDC_UNIT,
        refunded: 0n,
        canceled: false,
        start: NOW - 100n,
        stop: 0n,
        interval: 1n,
        amountPerInterval: USDC_UNIT,
        accrued: 10n * USDC_UNIT,
        settleable: 0n,
        refundIfCanceled: 0n,
      },
      {
        id: 3n,
        role: "payee",
        payer: PAYEE,
        payee: ACCOUNT,
        token: USDC,
        deposit: 50n * USDC_UNIT,
        paid: 0n,
        refunded: 0n,
        canceled: false,
        start: NOW - 100n,
        stop: 0n,
        interval: 1n,
        amountPerInterval: USDC_UNIT / 10n,
        accrued: 10n * USDC_UNIT,
        settleable: 10n * USDC_UNIT,
        refundIfCanceled: 0n,
      },
    ],
    vaults: [
      {
        id: 1n,
        token: USDC,
        balance: 30n * USDC_UNIT,
        unlockAt: NOW - 1n,
        owner: OWNER,
        nonce: 0n,
        unlocked: true,
      },
      {
        id: 2n,
        token: USDC,
        balance: 40n * USDC_UNIT,
        unlockAt: NOW + 86_400n,
        owner: OWNER,
        nonce: 3n,
        unlocked: false,
      },
      {
        id: 3n,
        token: USDC,
        balance: 50n * USDC_UNIT,
        unlockAt: NOW + 86_400n,
        owner: OTHER,
        nonce: 0n,
        unlocked: false,
      },
      { id: 4n, token: USDC, balance: 0n, unlockAt: NOW - 1n, owner: OWNER, nonce: 0n, unlocked: true },
    ],
    spendKeys: [
      {
        address: SPEND_KEY,
        token: USDC,
        balance: 7n * USDC_UNIT,
        allowance: 2n ** 256n - 1n,
        sweepable: 7n * USDC_UNIT,
      },
    ],
    findings: [],
    labels: knownLabels({
      contracts,
      usdc: USDC,
      compatibilityFallbackHandler: SAFE_V141.compatibilityFallbackHandler,
    }),
    compatibilityFallbackHandler: SAFE_V141.compatibilityFallbackHandler,
  };
  return { ...base, ...overrides };
}
