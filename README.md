## About

Script for generating GDA related activity.  
Can be used on devnets or public testnets.

===============
TEMPORARY REQUIREMENT

The dependency `@superfluid-finance/ethereum-contracts` is also needed, but omitted in package.json, because not yet release with GDA support.
You need to manually add it:
Navigate to a local copy of ethereum-contracts (gda branch) which you did already build. Then do `yarn link`.
Then navigate to the root of this project and do `yarn link @superfluid-finance/ethereum-contracts`.
===============

On start, the application first bootstraps and then periodically exexutes a randon action.
Bootstrapping consists of:
* fund a sender account and a receiver account with native coins (so they can do transactions)
* mint fake tokens (the underlying of the configured SuperToken is expected to implement `mint(address receiver, uint256 amount)`) and send some to the sender account
* create a pool
* provide units on the pool to the receiver account
* let the receiver account connect the pool

Some or all of this steps can be skipped if not needed, depends on the configuration provided (e.g. pool address provided) and chain state.
Relevant env vars (all optional, especially on devnets):
 * RPC
 * MNEMONIC (defaults to mnemonic of SF testenv)
 * SUPERTOKEN unless the sender account already has a sufficient balance, the SuperToken needs to have an underlying implementing `mint(address receiver, uint256 amount)`
 * POOL (defaults to undefined, which triggers creation of a new pool)
 * GDA_FORWARDER (defaults to the value in metadata)
 * ACTION_INTERVAL interval in seconds for triggering random actions
 * INSTANCE_ID can be set in order to run multiple instances in parallel, in order to have multiple senders. Can share an mnemonic, the sender and receiver account derivation path is shifted based on this id

 Env vars can also be provided via .env file.

### Run on devnet

In order to get going quickly on a devnet, do:
```
# checkout protocol-monorepo somewhere, then
cd protocol-monorepo
yarn install && yarn build
cd packages/ethereum-contracts
yarn testenv:start
# open a new terminal
npx truffle exec ops-scripts/deploy-test-environment.js
```

Now you have a dev chain running with the protocol and test tokens deployed.
The default config of this application will use accounts and contract addresses matching that devchain deployment.
Just run
```
yarn start
```

This will bootstrap and then 

### Run on public testnet

For public testnets, you have to provide a bit more configuration.  
Most importantly, you need to provide you own mnemonic, because nowadays funds on accounts with published secret will be drained even from testnets.

The account at the default derivation path (admin account) needs to be funded with native coins.

After running once, you may want to set the created pool at env var `POOL` in order to reuse it in consecutive runs.

Example invocation for running on avalanche-fuji, using a pre-existing pool, triggering a random action every 15 minutes, using fDAIx:
```
POOL=0x254DE04a9d7284205475DCd4c07D08d2cB633A9C INSTANCE_ID=1 GDA_FORWARDER=0x6dA170169d5Fca20F902b7E5755346a97c94B07c RPC=https://avalanche-fuji.rpc.x.superfluid.dev SUPERTOKEN=0x24f3631dbbf6880C684c5e59578C21194e285Baf ACTION_INTERVAL=900 MINT_AMOUNT=10000 MIN_ETH_BALANCE="0.5" node app.js
```
(GDA_FORWARDER can be omitted once it's included in a metadata release)

### Manual trigger

When debugging something, you may sometimes want to trigger a specific action.  
Instead of waiting for that to happen randomly, you can also trigger it manually.
A webservice is listening at port `3000 + instanceId` (or specified via env var `PORT`).
It can be used to manually trigger actions. Url: /<name of do function>[amount=<amountInWei>]
Example:
```
curl http://localhost:3001/doFlowDistribute 3140000000000000000
```
Would start a flow distribution of 3.14 tokens per hour to the pool (updates the flowrate if there already is a flow distribution).

Implemented do functions:
- doTransferOut
- doTransferIn
- doDistribute
- doDistributeFlow

Note that for `doDistributeFlow` the amount is interpreted as flowrate per hour.

### Caveats

If running multiple instances with the same mnemonic, make sure to set `INSTANCE_ID` with different values (e.g. 1, 2, 3, ...).
Even then there's a chance of nonce conflicts with the admin account.
But this shouldn't occur often as long as you avoid bootstrapping instances at the same time and don't put a very low interval (few seconds).