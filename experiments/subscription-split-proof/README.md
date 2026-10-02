# Tempo subscription split verifier experiment

This directory preserves the 2026-10-01 split schema/verifier experiment and documents the 2026-10-02 SDK lifecycle follow-up. Both use the existing subscription access-key mechanism and deploy no application Solidity. This remains experimental support, not a merge-ready implementation.

## SDK lifecycle follow-up, 2026-10-02

The local follow-up extends `src/tempo/subscription/Types.ts` and `src/tempo/server/Subscription.ts`, with twelve new cases in `Subscription.test.ts`. Approved raw-unit splits are persisted in the subscription record and included in stable, reuse and hook-result binding. Activation and renewal snapshot the approved terms before custom callbacks run, so in-place mutations cannot alter both sides of the comparison. Default HTTP activation and request/background renewal share the existing charge transfer builder. Sponsored calls are checked against every allocation, and confirmed receipts must credit every leg. Split payments require `waitForConfirmation: true`; existing single-recipient optimistic behavior remains available.

The server suite passes 52 tests, surrounding schema/key/store/lifecycle suites pass 73 tests, and the standalone signed verifier passes 33 checks. Strict source typechecking, scoped lint and formatting pass using the checkout's frozen dependencies. Generated HTML modules were built locally; the prior dependency/compiler limitation below describes the earlier frozen run.

A separate local Tempo v1.15.0 proof passes 24 checks using viem 2.57.1, isolated chain ID 1337 and the T11 control genesis. It exercises the default sponsored SDK HTTP activation and backend renewal, rather than a custom settlement callback. One root-key grant pays 8/2 on activation and a later renewal again pays 8/2. Concurrent renewals settle only once; changed shares or recipients cannot reuse the subscription. A blocked platform receive policy succeeds onchain with creator 8, platform 0 and guard 2; the SDK rejects settlement and does not advance the paid period. A same-period retry fails with the period cap consumed and moves no additional principal. Native receive-policy and existing store failure/retry semantics remain unchanged. No recovery state or claim/refund mechanism was added.

The 2026-10-01 evidence below remains the original schema/verifier experiment. This follow-up does not add onchain exact-share enforcement or establish wallet UI, public-network compatibility, unattended public-testnet renewals, durable-store crash recovery or production readiness. Native grants still limit total spending and permitted recipients; custom hooks remain responsible for proving their settlement.

## Candidate update

The original candidate changed two source files: `src/tempo/Methods.ts` and `src/tempo/subscription/KeyAuthorization.ts`. That source diff is 59 additions and 10 deletions. It is based on the reviewed mppx source at upstream commit `569be2193efe230acec81414d4660c7c1c8387d3` and the published feasibility branch at `5c83d972449273d942a2b7638f716831ba395038`.

The input reuses charge-style splits: amount 10, primary creator recipient, platform split amount 2. The primary amount is the remainder 8. Amounts normalize to raw six-decimal units under `methodDetails.splits`.

| Stage                | Candidate behavior                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema               | Positive shares, split total below total, valid normalized unique addresses, no collision with primary recipient, maximum ten splits                |
| Client authorization | Existing periodic token cap, expiry and witness; transferWithMemo scope lists creator and platform                                                  |
| Verifier             | Exactly the approved recipient set, without omissions, extras or duplicates; existing token, total cap, period, expiry, chain and key checks remain |
| Request integrity    | Existing challenge HMAC covers the complete split request; signed authorization witness binds the challenge ID                                      |
| Runtime execution    | Experimental callback builds two transferWithMemo calls with existing charge getTransfers and submits one native transaction                        |
| Receipt verification | Checks actual per-recipient token, source, amount and memo events after confirmation                                                                |

The standalone key verifier cannot validate an altered split request paired with an unchanged challenge ID. The existing challenge verification must run with it, as the SDK pipeline normally does. A reissued challenge changes the witness, so the old authorization fails. Neither stage forces the native key to allocate 8/2 on each execution: the native grant contains an allowed recipient list and aggregate token budget.

## Verified results

33 signed schema/verifier checks and 64 local chain checks passed, for 97 total. There are 14 unique transaction receipts: 11 successful, 3 reverted, plus one RPC rejection after key revocation. Every submitted transaction receipt is checked against its exact submitted hash. Sequential replacement detection is disabled for Tempo expiring-nonce transactions.

| Case                                       | Actual result                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Existing single recipient                  | Signing and verification preserved                                                                                                       |
| Valid two-recipient grant                  | One local payer-signed grant registers the key and pays exact 8/2                                                                        |
| Later billing period                       | Same access key pays another 8/2 without another root authorization                                                                      |
| Same-period full repeat                    | Native SpendingLimitExceeded; principal unchanged                                                                                        |
| Concurrent renewals                        | Existing memory-store claim permits only one callback/transaction; subsequent same-period store renewal skips                            |
| Unapproved destination                     | Native transaction reverts before user calls; no principal movement or budget consumption. Same funded key can pay an approved recipient |
| Root revokes key                           | Native metadata confirms isRevoked=true; a previously valid one-unit payment is rejected with remaining budget available                 |
| Backend submits 10/0                       | Native key accepts it despite having passed the proposed verifier against an approved 8/2 request                                        |
| Backend submits only creator 8             | Native key accepts it; platform unchanged and remaining period budget is 2                                                               |
| Platform receive policy blocks 8/2 batch   | Receipt succeeds; creator receives 8, platform receives zero, guard holds 2; all 10 of the key budget is consumed                        |
| Clear receive policy and retry same period | SpendingLimitExceeded; already committed principal remains unchanged                                                                     |

Receipt checks detect the three bad distribution cases after inclusion, but cannot undo their principal movement. The fixed-allocation and all-beneficiaries-credit-or-no-principal requirements therefore fail under this native allowlist plus ordinary-transfer extension. These are demonstrated counterexamples, not wallet incompatibility claims.

## Test scope

The chain run uses official Tempo v1.15.0 (`464e51994b541b37cb875d47747e38bb67e3692a`), isolated chain ID 1337, with T11 active and T12/T13 removed from the official dev genesis. No public network was queried or charged. viem 2.55.10, ox 0.14.33, zod 4.4.3, tsx 4.23.1 and TypeScript 7.0.2 were reused from the existing local installation.

The positive renewal uses a ten-second development period to observe a real reset. Negative distribution cases each use a fresh distinct access key with a daily cap. The payment token is separate from the fee token; fees are sponsored by a public development account and excluded from principal assertions. Keys derive only from the well-known public dev mnemonic and are never serialized into evidence.

The test calls the modified subscription signing/verifier helpers, existing charge transfer builder, native keychain and existing `SubscriptionStore.renew`. Its custom renewal callback closes over the split request. The store backend is memory, with simultaneous renewal callers. This proves that composition locally; it does not prove persistent-store restart/crash recovery or a complete HTTP subscription.

At the original schema/verifier-only snapshot, the default production payment handler remained unchanged and sent the total to one recipient. Split persistence, subscription binding, activation and renewal batch construction, fee-payer checks, receipts and lifecycle integration were still missing. The local SDK lifecycle follow-up above addresses those execution gaps; the frozen chain results below came from the earlier custom composition.

Actual wallet approval/UI, live-network compatibility and unattended public-testnet renewals remain outside this experiment. Local access-key registration, period reset, backend execution and onchain revoke are now measured rather than only inferred.

## Verification limits

`git diff --check`, shell syntax and both test runners passed. Read-only independent review confirmed the final receipts and counterexamples.

Strict compiler checking did not pass overall: two generated HTML modules are absent and the reused older viem lacks the upstream `ousd` token export. An unchanged baseline checkout with the same dependencies produces exactly the same three diagnostics as the candidate and both runners, with no additional diagnostics. No declaration stubs or SDK behavior were changed to hide those errors. Both diagnostic sets are included under `evidence/`.

## Reproduce locally

This branch contains the candidate source changes and experiment. Use the repository dependencies according to its manifest or reproduce the recorded local versions. The recorded run reused existing dependencies; a fresh installation was not tested. The frozen evidence is under `evidence/`; runtime outputs are ignored.

From the checkout root:

```sh
node --import tsx experiments/subscription-split-proof/unit.ts
bash experiments/subscription-split-proof/run-local.sh /absolute/path/to/tempo-v1.15.0
```

The launcher requires Foundry cast on PATH, binds RPC to 127.0.0.1:19547, disables discovery/bootnode lookup, rejects an occupied port, and stops the node on exit. The supplied source file is a funded local dev genesis, not a public network genesis.

Published as an experiment for RFC #920 discussion. The original Solidity feasibility branch remains unchanged. No PR or package release is included.
