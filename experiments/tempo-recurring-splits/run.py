"""Real Tempo RPC experiment. Uses only public dev accounts, Python, and cast."""
import json
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RPC = "http://127.0.0.1:19545"
MNEMONIC = "test test test test test test test test test test test junk"
TOKEN = "0x20c0000000000000000000000000000000000001"
REGISTRY = "0x403c000000000000000000000000000000000000"
GUARD = "0xB10C000000000000000000000000000000000000"
ZERO = "0x" + "00" * 20
evidence = {"checks": [], "transactions": [], "snapshots": {}}


def cast(*args):
    result = subprocess.run(["cast", *map(str, args)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()


def rpc(method, *params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    with urllib.request.urlopen(urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})) as response:
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result["result"]


def check(name, condition):
    assert condition, name
    evidence["checks"].append(name)
    print("PASS", name, flush=True)


def send(index, *args, ok=True):
    # --async avoids cast treating the intentionally reverted receipt as CLI failure.
    tx = cast("send", "--mnemonic", MNEMONIC, "--mnemonic-index", index,
              "--legacy", "--gas-limit", 3000000, "--rpc-url", RPC, "--async", *args)
    for _ in range(100):
        receipt = rpc("eth_getTransactionReceipt", tx)
        if receipt:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("Receipt timeout: " + tx)
    evidence["transactions"].append(receipt)
    assert int(receipt["status"], 16) == int(ok), receipt
    return receipt


def call(address, signature, *args):
    return cast("call", address, signature, *args, "--rpc-url", RPC)


def number(address, signature, *args):
    return int(call(address, signature, *args).split()[0])


accounts = [cast("wallet", "address", "--mnemonic", MNEMONIC, "--mnemonic-index", i) for i in range(4)]
payer, relayer, creator, platform = accounts
evidence["client"] = rpc("web3_clientVersion")
check("expected Tempo v1.15.0 build", evidence["client"].startswith("tempo/v1.15.0-464e519/"))
check("expected chain ID 1337", rpc("eth_chainId") == "0x539")
check("TIP20 has six decimals", number(TOKEN, "decimals()(uint8)") == 6)


def deploy(name="SplitProof", cadence=86400, lifetime=172800):
    artifact = json.loads((ROOT / "out" / "SplitProof.sol" / (name + ".json")).read_text())
    args = cast("abi-encode", "f(address,address,address,uint256,uint256)", TOKEN, creator, platform, cadence, lifetime)
    receipt = send(0, "--create", artifact["bytecode"]["object"] + args[2:])
    address = receipt["contractAddress"]
    send(0, TOKEN, "approve(address,uint256)", address, 100000000)
    return address


def snapshot(router):
    return {"balances": {a: number(TOKEN, "balanceOf(address)(uint256)", a) for a in [payer, creator, platform, GUARD]},
            "allowance": number(TOKEN, "allowance(address,address)(uint256)", payer, router),
            "paid0": call(router, "paid(uint256)(bool)", 0)}


def reject(router, a, b, signature):
    before = snapshot(router)
    receipt = send(1, router, "settle(uint256,uint256)", a, b, ok=False)
    trace = rpc("debug_traceTransaction", receipt["transactionHash"], {"tracer": "callTracer"})
    check(signature + " revert selector", trace.get("output", "").startswith(cast("sig", signature)))
    check(signature + " preserves balances, allowance, paid marker", snapshot(router) == before)
    return receipt, trace


router = deploy()
send(3, REGISTRY, "setReceivePolicy(uint64,uint64,address)", 0, 1, ZERO)
policy = call(REGISTRY, "validateReceivePolicy(address,address,address)(bool,uint8)", TOKEN, payer, platform)
check("platform receive policy rejects payer", policy.splitlines()[0] == "false")
before = snapshot(router)
receipt, trace = reject(router, 8000000, 2000000, "CreditMismatch(address,uint256,uint256)")
expected = cast("sig", "CreditMismatch(address,uint256,uint256)") + cast("abi-encode", "f(address,uint256,uint256)", platform, 2000000, 0)[2:]
check("second leg fails on zero actual platform credit", trace["output"].lower() == expected.lower())
reads = [c for c in trace["calls"] if c["input"].lower() == cast("calldata", "balanceOf(address)", creator).lower()]
check("trace proves first leg credited before outer revert", len(reads) == 2
      and int(reads[1]["output"], 16) - int(reads[0]["output"], 16) == 8000000)
check("reverted payment commits no payout or hold logs", all(log["topics"][0] != cast("keccak", "TransferBlocked(address,address,uint64,uint256,uint8,bytes)")
      and (len(log["topics"]) < 3 or int(log["topics"][2], 16) not in [int(creator, 16), int(platform, 16), int(GUARD, 16)])
      for log in receipt["logs"]))
evidence["guardedTrace"] = trace
evidence["snapshots"]["rollbackBefore"] = before
evidence["snapshots"]["rollbackAfter"] = snapshot(router)

# Mutation control: removing the credit check must break the rollback invariant.
unsafe = deploy("UnguardedSplitProof")
before = snapshot(unsafe)
receipt = send(1, unsafe, "settle(uint256,uint256)", 8000000, 2000000)
after = snapshot(unsafe)
check("unsafe control pays creator but holds platform share", after["balances"][creator] - before["balances"][creator] == 8000000
      and after["balances"][platform] == before["balances"][platform]
      and after["balances"][GUARD] - before["balances"][GUARD] == 2000000
      and before["balances"][payer] - after["balances"][payer] == 10000000)
check("mutation detected: success does not imply atomic delivery", after != before and after["paid0"] == "true")
blocked_topic = cast("keccak", "TransferBlocked(address,address,uint64,uint256,uint8,bytes)")
blocked = [log for log in receipt["logs"] if log["topics"][0] == blocked_topic]
check("control emits one TransferBlocked", len(blocked) == 1)
log = blocked[0]
check("reverted hold did not consume guard nonce", int(log["topics"][3], 16) == 1)
data = bytes.fromhex(log["data"][2:])
offset = int.from_bytes(data[64:96], "big")
length = int.from_bytes(data[offset:offset + 32], "big")
witness = "0x" + data[offset + 32:offset + 32 + length].hex()
check("held receipt preserves exact control entitlement", number(GUARD, "balanceOf(bytes)(uint256)", witness) == 2000000)
evidence["controlWitness"] = witness

send(3, REGISTRY, "setReceivePolicy(uint64,uint64,address)", 1, 1, ZERO)
before = snapshot(router)
send(1, router, "settle(uint256,uint256)", 8000000, 2000000)
after = snapshot(router)
check("same period retry pays exact 8/2", after["balances"][creator] - before["balances"][creator] == 8000000
      and after["balances"][platform] - before["balances"][platform] == 2000000
      and before["balances"][payer] - after["balances"][payer] == 10000000
      and before["allowance"] - after["allowance"] == 10000000 and after["paid0"] == "true"
      and after["balances"][GUARD] == before["balances"][GUARD])
reject(router, 8000000, 2000000, "AlreadyPaid()")
fresh = deploy()
reject(fresh, 10000000, 0, "Terms()")
send(1, fresh, "cancel()", ok=False)
check("relayer cannot cancel payer authorization", call(fresh, "cancelled()(bool)") == "false")
send(0, fresh, "cancel()")
reject(fresh, 8000000, 2000000, "Inactive()")
expired = deploy(lifetime=0)
reject(expired, 8000000, 2000000, "Inactive()")

# Short cadence is for the experiment only, not a proposed billing cadence.
renewal = deploy(cadence=3, lifetime=60)
send(1, renewal, "settle(uint256,uint256)", 8000000, 2000000)
time.sleep(3.2)
before = snapshot(renewal)
send(1, renewal, "settle(uint256,uint256)", 8000000, 2000000)
after = snapshot(renewal)
check("later period can renew with exact shares", after["balances"][creator] - before["balances"][creator] == 8000000
      and after["balances"][platform] - before["balances"][platform] == 2000000)
(ROOT / "results.json").write_text(json.dumps(evidence, indent=2) + "\n")
print(f"All {len(evidence['checks'])} checks passed; evidence: {ROOT / 'results.json'}")
