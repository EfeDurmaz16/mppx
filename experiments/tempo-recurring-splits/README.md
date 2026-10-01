# Recurring split feasibility experiment

Prototype supporting [RFC #920](https://github.com/wevm/mppx/issues/920). This folder contains a standalone local settlement experiment. Wallet approval and mppx access-key integration remain unverified.

Originally executed on 2026-09-27 and re-run without source changes on 2026-10-01 against the native Tempo v1.15.0 dev node, commit `464e51994b541b37cb875d47747e38bb67e3692a`, chain ID 1337. No mocks, public testnet, or real funds. Solidity compilation used solc 0.8.30 with Foundry 1.7.1; execution used the actual Tempo node, not Foundry's EVM.

## Result

All 25 assertions passed in both fresh-chain runs. Included evidence is from the 2026-10-01 run. The local node was stopped afterward.

| Scenario | Observed result |
| --- | --- |
| Creator receives 8, platform's 2 is held | Outer call reverts; payer, creator, platform, and guard principal balances, allowance, and period marker are unchanged |
| Inner execution trace | Creator balance increased by 8 before the second leg returned true with zero platform credit; router reverted with the expected recipient and amount |
| Guard state | No committed hold log; the subsequent control hold used nonce 1 and recorded exactly 2 tokens |
| Deliberately remove balance-delta check | Transaction succeeds with 8 delivered and 2 held, demonstrating the check is necessary |
| Clear receive policy and retry | Same unpaid period succeeds with exactly 8 and 2; allowance decreases by 10 |
| Repeat paid period or change 8/2 to 10/0 | Rejected with expected error, no payment-state changes |
| Relayer attempts cancellation | Rejected; mandate remains active |
| Payer cancels or mandate expires | Collection rejected with unchanged payment state |
| Next period | Exact distribution succeeds again |

Receipts, transaction hashes, state snapshots, and the reverted call trace are in [results.json](results.json). Human-readable execution output is in [test-output.txt](test-output.txt). Fees are paid by a separate relayer during settlement tests and are excluded from the payment-principal rollback guarantee. Fee logs can survive a reverted user call.

## Reproduce

Download the official [Tempo v1.15.0 release](https://github.com/tempoxyz/tempo/releases/tag/v1.15.0), verify its published checksum, then run:

```sh
bash run-local.sh /absolute/path/to/tempo-v1.15.0-aarch64-apple-darwin
```

The tested archive SHA256 was `7d67b198c63d1e9e0d3317c36e93035dc8077bf18aa4a05ccb8dce1eff91ff4f`. Requires `forge`, `cast`, Python 3, and solc 0.8.30 (Foundry can download it). The script starts a fresh temporary chain on loopback port 19545 and stops that node on exit. It retains the temporary chain directory. The direct `run.py` entry point assumes a fresh chain with no prior blocked transfers.

## Boundaries

- Payer deployment fixes the token and recipients; amounts are hardcoded to 8/2. Setup uses two payer transactions: contract deployment, then a separate token approval. A single wallet approval or batched setup has not been implemented or tested. This is a deliberately small authorization model, not a proposed production API.
- Settlement is permissionless: a separate relayer account triggers collection using the existing payer allowance. Two local relayer settlements were tested. There is no backend scheduler or public-testnet unattended renewal test.
- The expiry rejection case deploys an already-expired contract with lifetime zero. An active mandate aging through its expiry was not separately tested.
- Contract cancellation does not clear token allowance, and the prototype has no access key. Access-key revocation is not its cancellation mechanism.
- Contract cancellation is tested. Access-key revocation, signed mandates, wallet approval, current MPP credentials, refunds, and allowance-revocation behavior are not tested.
- One ordinary TIP-20 token and distinct normal addresses are exercised. Alias addresses, issuer restrictions, pauses, other token behavior, and a full production input-validation matrix are outside this proof.
- Replay is tested sequentially. Concurrent submissions and cancellation ordering races are not tested.
- The short cadence used for renewal is test-only. It does not verify existing MPP schedule mapping or missed-period billing rules.
- The [dev chainspec activates development hardforks at genesis](https://github.com/tempoxyz/tempo/blob/v1.15.0/docs/localnet.md#protocol-semantics). These results do not establish mainnet feature availability.
- A router must independently enforce authorization, period limits, and revocation. Token allowance alone is not a subscription mandate. This contract is not audited or production-ready.

## Source provenance and local-development credentials

The Solidity contract, Python runner, shell runner, Foundry config, and ignore file are unchanged from the original experiment. `SHA256SUMS` records the files in this experiment, including the fresh evidence.

The scripts contain the standard public development mnemonic for deterministic local accounts. It is intentional test data, not a live wallet credential. Use these accounts only on the local development chain and never fund them on a live network. The Python runner checks both the expected Tempo build and chain ID 1337 before deployment or payment transactions.

The output's personal absolute path has been replaced by `results.json`. Generated build/cache files, node logs, temporary chain data and the downloaded runtime are excluded. The unsafe contract is retained only as the clearly marked mutation control required to reproduce the evidence.
