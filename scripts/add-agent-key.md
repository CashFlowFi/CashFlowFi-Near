# Agent function-call key

The underwriter agent signs `attest_receipt` and `set_merchant_tier` with a **function-call
access key** on `AGENT_ACCOUNT`. Both methods take 0 deposit, so a function-call key works.
The key can call only those two methods, only on the contract, and gas comes from its allowance.

## 1. Generate the key pair straight into `.env`

The private key goes into `.env` and is never printed. Only the public key is printed.

```bash
node -e '
const fs=require("fs");const {KeyPair}=require("near-api-js");
const env=fs.existsSync(".env")?fs.readFileSync(".env","utf8"):"";
if(/^AGENT_PRIVATE_KEY=.+/m.test(env)){console.error("AGENT_PRIVATE_KEY already set");process.exit(1)}
const kp=KeyPair.fromRandom("ed25519");
fs.writeFileSync(".env",env.replace(/^AGENT_PRIVATE_KEY=.*\n?/m,"")+`AGENT_PRIVATE_KEY=${kp.toString()}\n`,{mode:0o600});fs.chmodSync(".env",0o600);
console.log(kp.getPublicKey().toString());'
```

## 2. Add it to the agent account (near-cli-rs)

Replace the placeholders, then sign with the agent account's full-access key from your keychain.

```bash
near account add-key <AGENT_ACCOUNT> \
  grant-function-call-access \
    --allowance '1 NEAR' \
    --contract-account-id <CASHFLOW_CONTRACT> \
    --function-names 'attest_receipt, set_merchant_tier' \
  use-manually-provided-public-key <PUBLIC_KEY_FROM_STEP_1> \
  network-config testnet \
  sign-with-keychain \
  send
```

Use `sign-with-legacy-keychain` if the account's key is in `~/.near-credentials/testnet/`.

## 3. Check it

```bash
near account list-keys <AGENT_ACCOUNT> network-config testnet now
```

The new key should show `function call` access to `<CASHFLOW_CONTRACT>` with both method names.
The contract's `agent_id` (set in `new`) must equal `AGENT_ACCOUNT`.

## 4. Run the agent

```bash
node agent/run.mjs --once      # one pass, for demo scripts
node agent/run.mjs --tiers     # poll every AGENT_POLL_SECONDS (15), also sync merchant tiers
```

Evidence is written to `evidence/attestations/<order_id>.json`.
