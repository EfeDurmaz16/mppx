import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { KeyAuthorization } from 'ox/tempo'
import { decodeErrorResult, encodeFunctionData, http, parseAbi, parseEventLogs, zeroAddress, type Account as ViemAccount, type Address, type Hex, type TransactionReceipt } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { Abis, Account, Actions, createClient } from 'viem/tempo'
import * as Challenge from '../../src/Challenge.js'
import * as Store from '../../src/Store.js'
import * as z from '../../src/zod.js'
import * as Methods from '../../src/tempo/Methods.js'
import { getTransfers } from '../../src/tempo/internal/Charge.js'
import { signSubscriptionKeyAuthorization, verifySubscriptionKeyAuthorization } from '../../src/tempo/subscription/KeyAuthorization.js'
import * as SubscriptionStore from '../../src/tempo/subscription/Store.js'
import type { SubscriptionRecord } from '../../src/tempo/subscription/Types.js'

// This known mnemonic is a public development fixture, never a real wallet.
const mnemonic = 'test test test test test test test test test test test junk'
function devKey(addressIndex: number): Hex {
  const key = mnemonicToAccount(mnemonic, { addressIndex }).getHdKey().privateKey
  assert(key)
  return `0x${Buffer.from(key).toString('hex')}`
}
const payer = Account.fromSecp256k1(devKey(0))
const sponsor = Account.fromSecp256k1(devKey(1))
const creator = Account.fromSecp256k1(devKey(2))
const platform = Account.fromSecp256k1(devKey(3))
const outsider = Account.fromSecp256k1(devKey(7))
const feeToken: Address = '0x20c0000000000000000000000000000000000001'
const registry: Address = '0x403c000000000000000000000000000000000000'
const guard: Address = '0xB10C000000000000000000000000000000000000'
const client = createClient({ account: payer, chain: tempoLocalnet, feeToken, transport: http('http://127.0.0.1:19547'), pollingInterval: 100 })
const checkNames: string[] = []
const transactions: unknown[] = []
const snapshots: Record<string, unknown> = {}
const rpcRejections: unknown[] = []
const serialize = (value: unknown) => JSON.stringify(value, (_, entry: unknown) => typeof entry === 'bigint' ? entry.toString() : entry, 2)
const check = (name: string, condition: boolean) => { assert(condition, name); checkNames.push(name); console.log('PASS', name) }
type Call = { to: Address; data: Hex }
const nativeCall = (call: { address: Address; data: Hex }): Call => ({ to: call.address, data: call.data })
async function send(label: string, account: ViemAccount, calls: Call[], keyAuthorization?: KeyAuthorization.Signed, expectFailure = false) {
  const hash = await client.sendTransaction({ account, calls, keyAuthorization, feeToken, feePayer: sponsor, nonceKey: 'expiring', gas: 8_000_000n })
  // Sequential-nonce replacement detection does not identify expiring-nonce lanes.
  const receipt = await client.waitForTransactionReceipt({ hash, checkReplacement: false })
  check(`${label}: receipt matches submitted transaction hash`, receipt.transactionHash === hash)
  transactions.push({ label, receipt })
  if (!expectFailure) check(`${label}: chain receipt success`, receipt.status === 'success')
  return receipt
}
function assertCredits(receipt: TransactionReceipt, token: Address, memo: Hex, transfers: ReturnType<typeof getTransfers>) {
  const logs = parseEventLogs({ abi: Abis.tip20, eventName: 'TransferWithMemo', logs: receipt.logs })
  for (const transfer of transfers) assert(logs.some(log => log.address.toLowerCase() === token.toLowerCase() && log.args.from.toLowerCase() === payer.address.toLowerCase() && log.args.to.toLowerCase() === transfer.recipient.toLowerCase() && log.args.amount === BigInt(transfer.amount) && log.args.memo === memo), 'Missing approved recipient credit')
}

let error: string | undefined
try {
  check('Pinned Tempo v1.15.0', (await client.request({ method: 'web3_clientVersion' })).startsWith('tempo/v1.15.0-464e519/'))
  check('Local chain 1337', await client.getChainId() === 1337)
  const created = await client.token.createSync({ name: 'Subscription Split Proof', symbol: 'SSP', currency: 'USD', quoteToken: feeToken, salt: `0x${'44'.repeat(32)}`, gas: 3_000_000n })
  const token = created.token
  transactions.push({ label: 'Create payment token', receipt: created.receipt })
  check('Separate principal token created', created.receipt.status === 'success')
  const issuer = await client.readContract({ address: token, abi: Abis.tip20, functionName: 'ISSUER_ROLE' })
  await send('Mint isolated payment principal', payer, [
    { to: token, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'grantRole', args: [issuer, payer.address] }) },
    { to: token, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'mint', args: [payer.address, 100_000_000n] }) },
  ])
  const balance = (address: Address) => client.readContract({ address: token, abi: Abis.tip20, functionName: 'balanceOf', args: [address] })
  const snapshot = async () => ({ payer: await balance(payer.address), creator: await balance(creator.address), platform: await balance(platform.address), guard: await balance(guard), outsider: await balance(outsider.address) })
  const memo = `0x${'55'.repeat(32)}` as const
  const callsFor = (transfers: readonly { recipient: Address; amount: string }[]) => transfers.map(transfer => ({ to: token, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [transfer.recipient, BigInt(transfer.amount), memo] }) }))
  async function fixture(index: number, periodCount = '1', periodUnit: 'day' | 'dev_second' = 'day') {
    const raw = Account.fromSecp256k1(devKey(index))
    const accessKey = { accessKeyAddress: raw.address, keyType: 'secp256k1' as const }
    const account = Account.fromSecp256k1(devKey(index), { access: payer.address })
    const request = Methods.subscription.schema.request.parse({ amount: '10', decimals: 6, currency: token, recipient: creator.address, splits: [{ recipient: platform.address, amount: '2' }], chainId: 1337, periodCount, periodUnit, subscriptionExpires: new Date((Math.floor(Date.now() / 1000) + 600) * 1000).toISOString() })
    const challenge = Challenge.from({ realm: 'localhost.subscription-split-proof', method: 'tempo', intent: 'subscription', request, secretKey: 'public-local-test-secret' })
    check(`Fixture ${index}: challenge HMAC matches approved split request`, Challenge.verify(challenge, { secretKey: 'public-local-test-secret' }))
    const authorization = await signSubscriptionKeyAuthorization({ accessKey, account: payer, chainId: 1337, challengeId: challenge.id, request })
    assert(authorization)
    const verified = verifySubscriptionKeyAuthorization({ accessKey, chainId: 1337, challengeId: challenge.id, request, payload: { type: 'keyAuthorization', signature: KeyAuthorization.serialize(authorization) } })
    check(`Fixture ${index}: expanded verifier recovers the payer`, verified.source.address.toLowerCase() === payer.address.toLowerCase())
    const transfers = getTransfers(request)
    check(`Fixture ${index}: existing charge builder computes exact 8/2`, transfers[0]?.amount === '8000000' && transfers[1]?.amount === '2000000')
    const remaining = () => client.accessKey.getRemainingLimit({ account: payer, accessKey: raw.address, token })
    return { accessKey, account, request, authorization, transfers, remaining }
  }
  async function reject(label: string, operation: () => Promise<TransactionReceipt>, expected: RegExp) {
    const before = await snapshot()
    let caught: unknown
    let reverted: TransactionReceipt | undefined
    try { reverted = await operation() } catch (cause) { caught = cause }
    let message: string
    if (reverted) {
      assert.equal(reverted.status, 'reverted', `${label}: must revert`)
      const traceSchema = z.object({ result: z.object({ output: z.optional(z.string()), calls: z.optional(z.array(z.object({ output: z.optional(z.string()) }))) }) })
      const raw: unknown = await fetch('http://127.0.0.1:19547', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_traceTransaction', params: [reverted.transactionHash, { tracer: 'callTracer' }] }) }).then(response => response.json())
      snapshots[`${label}:trace`] = raw
      const result = traceSchema.parse(raw).result
      const output = result.calls?.[0]?.output ?? result.output
      if (output && /^0x[0-9a-f]+$/i.test(output)) {
        message = decodeErrorResult({ abi: [...Abis.tip20, ...Abis.accountKeychain], data: output as Hex }).errorName
      } else {
        // Scope/revocation failures can stop before any user call, with no ABI revert data.
        assert(!result.calls?.length, 'Expected no user call before admission rejection')
        message = 'NativePreExecutionRevert'
      }
    } else {
      assert(caught instanceof Error, `${label}: must reject`)
      message = caught.message
    }
    check(`${label}: expected native rejection`, expected.test(message))
    check(`${label}: payment principal unchanged`, serialize(await snapshot()) === serialize(before))
    rpcRejections.push({ label, kind: reverted ? 'reverted receipt' : 'RPC rejection', reason: message.split('\n')[0], expected: expected.source })
  }
  async function waitForPeriod(currentFixture: Awaited<ReturnType<typeof fixture>>) {
    const deadline = Date.now() + 20_000
    while ((await currentFixture.remaining()).remaining !== 10_000_000n) {
      assert(Date.now() < deadline, 'Local period reset timeout')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    check('Existing access-key period cap resets to one 10-unit budget', true)
  }

  // A short dev period makes an actual activation and later renewal observable.
  const normal = await fixture(4, '10', 'dev_second')
  const activationBefore = await snapshot()
  const activation = await send('One payer grant plus activation 8/2', normal.account, callsFor(normal.transfers), normal.authorization)
  assertCredits(activation, token, memo, normal.transfers)
  const activated = await snapshot()
  check('Approved access key pays exact activation 8/2', activated.creator - activationBefore.creator === 8_000_000n && activated.platform - activationBefore.platform === 2_000_000n)
  check('Activation consumes the one-period native cap', (await normal.remaining()).remaining === 0n)
  await reject('Same-period repeat', () => send('Repeat attempt', normal.account, callsFor(normal.transfers), undefined, true), /spending.?limit|limit.?exceeded|overspend/i)
  await waitForPeriod(normal)
  const store = SubscriptionStore.fromStore(Store.memory())
  const record: SubscriptionRecord = { amount: normal.request.amount, billingAnchor: new Date().toISOString(), chainId: 1337, currency: token, accessKey: normal.accessKey, lastChargedPeriod: 0, lookupKey: 'local-normal', payer: { address: payer.address, chainId: 1337 }, periodCount: '10', periodUnit: 'dev_second', recipient: creator.address, reference: activation.transactionHash, subscriptionExpires: normal.request.subscriptionExpires, subscriptionId: 'local-subscription', timestamp: new Date().toISOString() }
  await store.put(record)
  let renewalsSubmitted = 0
  const renew = () => store.renew({ subscriptionId: record.subscriptionId, periodIndex: 1, inFlightReference: 'renewal:local-subscription:1', renew: async ({ subscription }) => {
    renewalsSubmitted++
    const receipt = await send('Backend renewal without another payer grant', normal.account, callsFor(normal.transfers))
    assertCredits(receipt, token, memo, normal.transfers)
    return { subscription: { ...subscription, lastChargedPeriod: 1, reference: receipt.transactionHash } }
  } })
  const simultaneous = await Promise.all([renew(), renew()])
  check('Existing store permits only one concurrent renewal submission', renewalsSubmitted === 1 && simultaneous.some(result => result.status === 'renewed') && simultaneous.some(result => result.status === 'inFlight'))
  check('Existing store skips an already-charged period', (await renew()).status === 'charged' && renewalsSubmitted === 1)
  const renewed = await snapshot()
  snapshots.normal = { activationBefore, activated, renewed }
  check('Actual backend renewal again pays exact 8/2 without new authorization', renewed.creator - activated.creator === 8_000_000n && renewed.platform - activated.platform === 2_000_000n)
  await waitForPeriod(normal)
  await reject('Unapproved recipient', () => send('Outsider payment attempt', normal.account, callsFor([{ recipient: outsider.address, amount: '1' }]), undefined, true), /recipient|not.?allowed|scope|unauthorized|NativePreExecutionRevert/i)
  check('Outsider rejection leaves the full available key budget intact', (await normal.remaining()).remaining === 10_000_000n)
  const scopeControlBefore = await snapshot()
  await send('Scope control: same key pays an approved recipient', normal.account, callsFor([{ recipient: creator.address, amount: '1' }]))
  check('Scope control succeeds with the same funded valid key', (await snapshot()).creator - scopeControlBefore.creator === 1n && (await normal.remaining()).remaining === 9_999_999n)
  await send('Payer revokes native subscription key', payer, [nativeCall(Actions.accessKey.revoke.call({ accessKey: normal.accessKey.accessKeyAddress }))])
  check('Native key metadata confirms revocation', (await client.accessKey.getMetadata({ account: payer, accessKey: normal.accessKey.accessKeyAddress })).isRevoked)
  await reject('Revoked key payment with available budget', () => send('Revoked-key payment attempt', normal.account, callsFor([{ recipient: creator.address, amount: '1' }]), undefined, true), /revok|not.?found|not.?authorized|unauthorized|access.?key|NativePreExecutionRevert/i)

  const changed = await fixture(5)
  const changedBefore = await snapshot()
  const altered = await send('Authorized backend changes approved 8/2 to 10/0', changed.account, callsFor([{ recipient: creator.address, amount: '10000000' }]), changed.authorization)
  const changedAfter = await snapshot()
  snapshots.alteredShares = { before: changedBefore, after: changedAfter }
  check('Counterexample: native allowlist accepts 10/0 under a verified 8/2 grant', changedAfter.creator - changedBefore.creator === 10_000_000n && changedAfter.platform === changedBefore.platform)
  assert.throws(() => assertCredits(altered, token, memo, changed.transfers), /Missing approved recipient credit/)
  check('Post-confirmation receipt verifier detects altered allocation', true)

  const omitted = await fixture(6)
  const omittedBefore = await snapshot()
  const partial = await send('Authorized backend omits platform leg', omitted.account, callsFor([omitted.transfers[0]!]), omitted.authorization)
  const omittedAfter = await snapshot()
  snapshots.omittedShare = { before: omittedBefore, after: omittedAfter, remaining: await omitted.remaining() }
  check('Counterexample: creator receives 8 alone; remaining cap is 2', omittedAfter.creator - omittedBefore.creator === 8_000_000n && omittedAfter.platform === omittedBefore.platform && (await omitted.remaining()).remaining === 2_000_000n)
  assert.throws(() => assertCredits(partial, token, memo, omitted.transfers), /Missing approved recipient credit/)
  check('Post-confirmation receipt verifier detects missing leg', true)

  const blocked = await fixture(8)
  const policyAbi = parseAbi(['function setReceivePolicy(uint64,uint64,address)', 'function validateReceivePolicy(address,address,address) view returns (bool,uint8)'])
  await send('Platform installs rejecting receive policy', platform, [{ to: registry, data: encodeFunctionData({ abi: policyAbi, functionName: 'setReceivePolicy', args: [0n, 1n, zeroAddress] }) }])
  check('Platform policy rejects payer', (await client.readContract({ address: registry, abi: policyAbi, functionName: 'validateReceivePolicy', args: [token, payer.address, platform.address] }))[0] === false)
  const blockedBefore = await snapshot()
  const held = await send('Verified subscription grant sends native 8/2 batch into hold', blocked.account, callsFor(blocked.transfers), blocked.authorization)
  const heldAfter = await snapshot()
  snapshots.heldShare = { before: blockedBefore, after: heldAfter, remaining: await blocked.remaining() }
  check('Counterexample: successful access-key batch pays creator 8, platform zero, guard 2', heldAfter.creator - blockedBefore.creator === 8_000_000n && heldAfter.platform === blockedBefore.platform && heldAfter.guard - blockedBefore.guard === 2_000_000n && blockedBefore.payer - heldAfter.payer === 10_000_000n)
  check('Held second share still consumes the complete periodic key budget', (await blocked.remaining()).remaining === 0n)
  assert.throws(() => assertCredits(held, token, memo, blocked.transfers), /Missing approved recipient credit/)
  check('Post-confirmation receipt verifier detects hold but does not roll back principal', true)
  await send('Clear platform receive policy', platform, [{ to: registry, data: encodeFunctionData({ abi: policyAbi, functionName: 'setReceivePolicy', args: [1n, 1n, zeroAddress] }) }])
  await reject('Same-period full retry after held share', () => send('Held-share retry attempt', blocked.account, callsFor(blocked.transfers), undefined, true), /spending.?limit|limit.?exceeded|overspend/i)
} catch (caught) {
  error = caught instanceof Error ? caught.message.split('\n')[0] : String(caught)
  let diagnostic = caught instanceof Error ? caught.message : String(caught)
  for (let index = 0; index < 24; index++) diagnostic = diagnostic.replaceAll(devKey(index), '[redacted development key]')
  writeFileSync('diagnostic.txt', diagnostic)
  console.error(error)
  process.exitCode = 1
} finally {
  writeFileSync('chain-results.json', serialize({ runtime: 'tempo/v1.15.0-464e519', chain: 'isolated local T11 control', sdk: 'viem@2.55.10', checks: checkNames, transactions, rpcRejections, snapshots, error }))
}
