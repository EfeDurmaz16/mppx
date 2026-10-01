import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { KeyAuthorization } from 'ox/tempo'
import { privateKeyToAccount } from 'viem/accounts'

import * as Challenge from '../../src/Challenge.js'
import * as Methods from '../../src/tempo/Methods.js'
import {
  getSubscriptionRpcAllowedCalls,
  getSubscriptionScopes,
  signSubscriptionKeyAuthorization,
  verifySubscriptionKeyAuthorization,
} from '../../src/tempo/subscription/KeyAuthorization.js'

// Public, fixed development accounts. Never use these keys on a public network.
const root = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`)
const access = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`)
const creator = '0x1111111111111111111111111111111111111111'
const platform = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const extra = '0x3333333333333333333333333333333333333333'
const currency = '0x20c0000000000000000000000000000000000001'
const accessKey = { accessKeyAddress: access.address, keyType: 'secp256k1' } as const
const secretKey = 'public-local-proof-challenge-secret'
const input = {
  amount: '10', currency, decimals: 6, recipient: creator,
  periodCount: '1', periodUnit: 'day', subscriptionExpires: '2030-01-01T00:00:00Z',
  accessKey, chainId: 1337,
}
const parse = (overrides: Record<string, unknown> = {}) =>
  Methods.subscription.schema.request.parse({ ...input, ...overrides })
type Request = ReturnType<typeof parse>
type Authorization = NonNullable<Awaited<ReturnType<typeof signSubscriptionKeyAuthorization>>>
const checks: { name: string; result: 'passed' }[] = []
function check(name: string, run: () => void) {
  run()
  checks.push({ name, result: 'passed' })
}
const single = parse()
const split = parse({ splits: [{ recipient: platform, amount: '2' }] })
const challenge = (request: Request) => Challenge.from({
  intent: 'subscription', method: 'tempo', realm: 'local-proof.invalid', request, secretKey,
})
const singleChallenge = challenge(single)
const splitChallenge = challenge(split)
async function sign(request: Request, challengeId: string) {
  const authorization = await signSubscriptionKeyAuthorization({
    accessKey, account: root, challengeId, chainId: 1337, request,
  })
  if (!authorization) throw new Error('Expected a local key authorization')
  return authorization
}
const singleAuthorization = await sign(single, singleChallenge.id)
const splitAuthorization = await sign(split, splitChallenge.id)
function verify(authorization: Authorization, request = split, challengeId = splitChallenge.id) {
  return verifySubscriptionKeyAuthorization({
    accessKey, chainId: 1337, request, challengeId,
    payload: { type: 'keyAuthorization', signature: KeyAuthorization.serialize(authorization) },
  })
}
async function mutate(overrides: Partial<Pick<Authorization, 'address' | 'chainId' | 'expiry' | 'limits' | 'scopes'>>) {
  const { signature: _signature, ...base } = splitAuthorization
  const unsigned = { ...base, ...overrides }
  const signature = await root.sign({ hash: KeyAuthorization.getSignPayload(unsigned) })
  return KeyAuthorization.from(unsigned, { signature })
}

check('single-recipient authorization remains valid', () => {
  assert.equal(verify(singleAuthorization, single, singleChallenge.id).source.address.toLowerCase(), root.address.toLowerCase())
  assert.deepEqual(getSubscriptionScopes(single)[0].recipients, [creator])
})
check('split request uses charge-style raw-unit methodDetails', () => {
  assert.equal(split.amount, '10000000')
  assert.deepEqual(split.methodDetails?.splits, [{ recipient: platform, amount: '2000000' }])
  assert.equal(BigInt(split.amount) - BigInt(split.methodDetails!.splits![0]!.amount), 8_000_000n)
})
check('split signed authorization verifies', () => assert.equal(verify(splitAuthorization).source.address.toLowerCase(), root.address.toLowerCase()))
check('wallet RPC scopes include exactly both recipients', () => {
  assert.deepEqual(getSubscriptionRpcAllowedCalls(split)[0].selectorRules[0].recipients, [creator, platform])
})
check('raw-unit methodDetails input survives normalization', () => {
  assert.deepEqual(parse({ methodDetails: { splits: [{ recipient: platform.toUpperCase().replace('0X', '0x'), amount: '2000000' }] } }).methodDetails?.splits,
    [{ recipient: platform, amount: '2000000' }])
})
for (const [name, overrides] of [
  ['zero split', { splits: [{ recipient: platform, amount: '0' }] }],
  ['negative split', { splits: [{ recipient: platform, amount: '-2' }] }],
  ['malformed split amount', { splits: [{ recipient: platform, amount: 'no' }] }],
  ['split equals total', { splits: [{ recipient: platform, amount: '10' }] }],
  ['split exceeds total', { splits: [{ recipient: platform, amount: '11' }] }],
  ['duplicate split recipients', { splits: [{ recipient: platform, amount: '2' }, { recipient: platform, amount: '1' }] }],
  ['split recipient equals primary', { splits: [{ recipient: creator, amount: '2' }] }],
  ['malformed recipient', { splits: [{ recipient: 'bad', amount: '2' }] }],
  ['empty split list', { splits: [] }],
  ['more than ten splits', { splits: Array.from({ length: 11 }, (_, i) => ({ recipient: `0x${(i + 10).toString(16).padStart(40, '0')}`, amount: '0.01' })) }],
  ['decimal amount in raw split', { methodDetails: { splits: [{ recipient: platform, amount: '0.2' }] } }],
  ['ambiguous dual split inputs', { splits: [{ recipient: platform, amount: '2' }], methodDetails: { splits: [{ recipient: platform, amount: '2000000' }] } }],
] as const) check(`schema rejects ${name}`, () => assert.throws(() => parse(overrides)))

for (const [name, recipients] of [
  ['extra recipient', [creator, platform, extra]],
  ['missing platform', [creator]],
  ['missing creator', [platform]],
  ['duplicate recipient', [creator, creator]],
  ['unscoped recipient list', []],
] as const) {
  const authorization = await mutate({ scopes: [{ ...splitAuthorization.scopes![0]!, recipients: [...recipients] }] })
  check(`verifier rejects ${name}`, () => assert.throws(() => verify(authorization), /recipient mismatch/))
}
const reversed = await mutate({ scopes: [{ ...splitAuthorization.scopes![0]!, recipients: [platform, creator] }] })
check('recipient set matching is independent of ordering', () => assert.doesNotThrow(() => verify(reversed)))
for (const [name, overrides, reason] of [
  ['wrong cap', { limits: [{ ...splitAuthorization.limits![0]!, limit: 11_000_000n }] }, /amount mismatch/],
  ['wrong period', { limits: [{ ...splitAuthorization.limits![0]!, period: 604800 }] }, /period mismatch/],
  ['wrong currency', { limits: [{ ...splitAuthorization.limits![0]!, token: extra }] }, /currency mismatch/],
  ['wrong chain', { chainId: 1338n }, /chainId mismatch/],
  ['wrong expiry', { expiry: splitAuthorization.expiry! - 1 }, /expiry mismatch/],
  ['wrong access key', { address: extra }, /access key mismatch/],
] as const) {
  const authorization = await mutate(overrides)
  check(`verifier rejects ${name}`, () => assert.throws(() => verify(authorization), reason))
}
const altered = parse({ splits: [{ recipient: platform, amount: '3' }] })
check('original signed challenge has valid HMAC', () => assert.equal(Challenge.verify(splitChallenge, { secretKey }), true))
check('changed share with old challenge id fails HMAC', () => {
  assert.equal(Challenge.verify({ ...splitChallenge, request: altered }, { secretKey }), false)
})
const newChallenge = challenge(altered)
check('new challenge for changed share rejects old authorization witness', () => {
  assert.equal(Challenge.verify(newChallenge, { secretKey }), true)
  assert.throws(() => verify(splitAuthorization, altered, newChallenge.id), /challenge mismatch/)
})
check('raw grant does not encode per-recipient amounts', () => {
  // The authenticated request binds the allocation for the SDK, while native scopes only bind recipients.
  assert.deepEqual(splitAuthorization.scopes?.[0]?.recipients?.map((value) => value.toLowerCase()), [creator, platform])
  assert.equal(splitAuthorization.limits?.[0]?.limit, 10_000_000n)
  assert.doesNotThrow(() => verify(splitAuthorization, altered, splitChallenge.id))
})

const directory = new URL('./results/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('verifier-checks.json', directory), `${JSON.stringify({
  experiment: 'subscription split verifier candidate',
  status: 'passed', checkCount: checks.length, checks,
  limitation: 'Challenge HMAC plus witness binds split terms for SDK verification. Native key scopes still authorize a recipient set plus aggregate cap, not fixed shares or required joint payments.',
}, null, 2)}\n`)
console.log(`Passed ${checks.length} signed verifier and schema checks.`)
