require('dotenv').config();
const e = require("ethers");
const sfAbis = require("@superfluid-finance/ethereum-contracts/build/bundled-abi");
// TODO: forwarders should be added to bundled-abi
sfAbis.GDAv1Forwarder = require("@superfluid-finance/ethereum-contracts/build/truffle/GDAv1Forwarder").abi;
sfAbis.IGeneralDistributionAgreement = require("@superfluid-finance/ethereum-contracts/build/truffle/IGeneralDistributionAgreementV1").abi;
sfAbis.ISuperfluidPool = require("@superfluid-finance/ethereum-contracts/build/truffle/ISuperfluidPool").abi;
sfAbis.TestToken = require("@superfluid-finance/ethereum-contracts/build/truffle/TestToken").abi;
// patch event abi into gda forwarder
sfAbis.GDAv1Forwarder.push(sfAbis.IGeneralDistributionAgreement.find(e => e.name === "PoolCreated"));
// TODO: fix this

const sfMeta = require("@superfluid-finance/metadata")

const rpcUrl = process.env.RPC || "http://localhost:47545";
const mnemonic = process.env.MNEMONIC || "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat";
const superTokenAddr = process.env.SUPERTOKEN || "0xb459d8D0a8493AAB413352f9577EB46b8d1f2537"; // fDAIx on devnet
let poolAddr = process.env.POOL || undefined; // new pool created if undefined
const mintAmountEth = process.env.MINT_AMOUNT || "1000"; // don't set below 100
const minEthBalance = process.env.MIN_ETH_BALANCE || "0.1";
const actionIntervalS = process.env.ACTION_INTERVAL || 6;
const instanceId = parseInt(process.env.INSTANCE_ID || 1);
const minBalance = e.utils.parseEther(minEthBalance);

// add dev network to meta
sfMeta.networks.push({
    name: "devnet",
    chainId: 1337,
    contractsV1: {
        resolver: "0xF12b5dd4EAD5F743C6BaA640B0216200e89B60Da",
        host: "0x30753E4A8aad7F8597332E813735Def5dD395028",
        gdaV1Forwarder: "0x2EcA6FCFef74E2c8D03fBAf0ff6712314c9BD58B",
    }
});

let adminSigner;
let senderSigner;
let receiverSigner;
let gdaForwarder;
let pool;
let superToken;

async function init() {
    let receipt;

    // initialize network

    const provider = new e.providers.JsonRpcProvider(rpcUrl);
    const chainId = (await provider.getNetwork()).chainId;
    console.log(`*** Bootstrapping instance ${instanceId}: connected to network via RPC ${rpcUrl} with chainId ${chainId}`);

    const network = sfMeta.getNetworkByChainId(chainId);

    // initialize wallet
    // TODO: generalize into function and reduce code redundancy
    adminSigner = e.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/0").connect(provider);
    senderSigner = e.Wallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${instanceId * 10 + 1}`).connect(provider);
    receiverSigner = e.Wallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${instanceId * 10 + 2}`).connect(provider);

    console.log(`admin account: ${adminSigner.address}`);
    console.log(`sender account: ${senderSigner.address}`);
    console.log(`receiver account: ${receiverSigner.address}`);

    // provide funds to accounts
    console.log(`minBalance: ${minBalance.toString()}`);

    const senderBalance = await senderSigner.getBalance();
    const receiverBalance = await receiverSigner.getBalance();

    console.log(`admin balance: ${e.utils.formatEther(await adminSigner.getBalance())}`);

    if (senderBalance.lte(minBalance)) {
        console.log("funding sender...");
        const tx = await adminSigner.sendTransaction({
            to: senderSigner.address,
            value: minBalance
        });
        receipt = await tx.wait();
        console.log(`r: ${JSON.stringify(receipt)}`);
    }

    if (receiverBalance.lte(minBalance)) {
        console.log("funding receiver...");
        const tx = await adminSigner.sendTransaction({
            to: receiverSigner.address,
            value: minBalance
        });
        receipt = await tx.wait();
        console.log(`r: ${JSON.stringify(receipt)}`);
    }

    // initialize contract instances
    const host = new e.Contract(network.contractsV1.host, sfAbis.ISuperfluid, provider);
    const hostNow = await host.getNow();
    console.log(`host now (timestamp): ${hostNow.toString()}`);

    superToken = new e.Contract(superTokenAddr, sfAbis.ISuperToken, provider);
    const tokenAddr = await superToken.getUnderlyingToken();
    console.log(`underlying of ${tokenAddr}: ${tokenAddr}`);

    // TestToken: ERC20 + mint function
    const mintAmount = e.utils.parseEther(mintAmountEth);
    const token = new e.Contract(tokenAddr, sfAbis.TestToken, adminSigner);
    console.log(`token balance of admin: ${await token.balanceOf(adminSigner.address)}`);
    const senderSuperTokenBalance = await superToken.balanceOf(senderSigner.address);
    console.log(`superToken balance of sender: ${senderSuperTokenBalance}`);

    if (senderSuperTokenBalance.lt(mintAmount.div(10))) {
        console.log("minting tokens to the admin...");
        await token.mint(adminSigner.address, mintAmount);
        // approve, upgrade and distribute to sender
        console.log("approve...");
        await (await token.connect(adminSigner).approve(superToken.address, mintAmount)).wait();
        console.log("upgrade...");
        await (await superToken.connect(adminSigner).upgrade(mintAmount)).wait();
        console.log("transferring superTokens to the sender...");
        await (await superToken.connect(adminSigner).transfer(senderSigner.address, mintAmount.div(5))).wait();
    }

    const gdaForwaderAddr = process.env.GDA_FORWARDER || network.contractsV1.gdaV1Forwarder;
    console.log(`init gda forwarder at ${gdaForwaderAddr}}...`);
    gdaForwarder = new e.Contract(gdaForwaderAddr, sfAbis.GDAv1Forwarder, provider);

    if (poolAddr === undefined) {
        console.log("create pool...");
        // [admin] gda.createPool(token, admin)
        const tx = await gdaForwarder.connect(adminSigner).createPool(superTokenAddr, adminSigner.address);
        receipt = await tx.wait();

        const poolCreatedEvent = receipt.events.find(e => e.event === "PoolCreated");
        //console.log(`event args: ${console.log(poolCreatedEvent.args)}`);
        poolAddr = poolCreatedEvent.args.pool;
        console.log(`created pool at ${poolAddr}`);
    }

    console.log(`init pool at ${poolAddr} ...`);
    pool = new e.Contract(poolAddr, sfAbis.ISuperfluidPool, adminSigner);
    // [admin] pool.updateMemberUnits(memberAddr, units)
    // TODO: we need guidelines for setting units
    const curReceiverUnits = await pool.getUnits(receiverSigner.address);
    console.log(`receiver units: ${curReceiverUnits.toString()}`);
    if (curReceiverUnits == 0) {
        const poolAdmin = await pool.admin();
        console.log(`pool admin: ${poolAdmin}`);
        if (poolAdmin !== adminSigner.address) {
            console.warn("!!! I'm not the pool admin, can't add receiver");
        } else {
            const newReceiverUnits = 1e12.toString();
            console.log(`Setting receiver units to ${newReceiverUnits}...`);
            receipt = await (await pool.updateMemberUnits(receiverSigner.address, newReceiverUnits)).wait();
        }
        console.log("Connecting receiver to pool...");
        // [receiver] gda.connectPool(pool, ctx)
        await (await gdaForwarder.connect(receiverSigner).connectPool(poolAddr, "0x")).wait();
    }

    // [receiver] pool.claimAll() 
    console.log("*** Bootstrapping done!");
}

// account is a map with the fields label and address
async function printBalances(token, accounts) {
    accounts.forEach(async acc => {
        const rTBal = await token.balanceOf(acc.address);
        console.log(`balance of ${acc.label} account: ${e.utils.formatEther(rTBal)}`);
    });
}

// ******************************************************************************
// do functions
// ******************************************************************************

// transfer from the sender
async function doTransferOut(transferAmount) {
    const curBalance = await superToken.balanceOf(senderSigner.address);
    if (curBalance.lt(transferAmount)) {
        console.log("skipping (not enough funds)");
        return;
    }
    console.log(`${new Date()} - doTransferOut ${e.utils.formatEther(transferAmount)}`);
    return await superToken.connect(senderSigner).transfer(adminSigner.address, transferAmount);
}

// transfer to the sender
async function doTransferIn(transferAmount) {
    console.log(`${new Date()} - doTransferIn ${e.utils.formatEther(transferAmount)}`);
    return await superToken.connect(adminSigner).transfer(senderSigner.address, transferAmount);
}

// distribute to the pool
async function doDistribute(distributeAmount) {
    const curBalance = await superToken.balanceOf(senderSigner.address);
    if (curBalance.lt(distributeAmount)) {
        console.log("skipping (not enough funds)");
        return;
    }
    console.log(`${new Date()} - doDistribute ${e.utils.formatEther(distributeAmount)}`);
    // [sender] gda.distribute(token, from, pool, amount, ctx)
    return await gdaForwarder.connect(senderSigner).distribute(
        superTokenAddr,
        senderSigner.address,
        pool.address,
        distributeAmount,
        "0x"
    );
}

// flow to the pool
async function doDistributeFlow(distributeFlowratePerHour) {
    const curBalance = await superToken.balanceOf(senderSigner.address);
    if (curBalance.lt(distributeFlowratePerHour)) {
        console.log("skipping (not enough funds)");
        return;
    }
    console.log(`${new Date()} - doDistributeFlow ${e.utils.formatEther(distributeFlowratePerHour.toString())} per hour`);
    // [sender] gda.distributeFlow(token, from, pool, flowrate, ctx)
    const distributeFlowrate = Math.floor(distributeFlowratePerHour / 3600); // per second
    return await gdaForwarder.connect(senderSigner).distributeFlow(
        superTokenAddr,
        senderSigner.address,
        pool.address,
        distributeFlowrate,
        "0x"
    );
}

// weights affecting how often a specific do function is called
const doFunctions = [
    { fn: doTransferOut, w: 1 },
    { fn: doTransferIn, w: 1 },
    { fn: doDistribute, w: 2 },
    { fn: doDistributeFlow, w: 1 }
];
const totalWeight = doFunctions.reduce((acc, f) => acc + f.w, 0);
console.log(`totalWeight: ${totalWeight}`);

// abstract do function which randomly dispatches one of the concrete do functions
async function doSomething() {
    const randomWeight = Math.random() * totalWeight;
    let cumulativeWeight = 0;
    doFunctions.reduce((acc, f) => {
        cumulativeWeight += f.w;
        f.cumulativeWeight = cumulativeWeight;
        return acc + f.w;
    }, 0);
    const selectedFunction = doFunctions.find(f => randomWeight <= f.cumulativeWeight);

    // choose random amount/flowrate in the range between 0 and 10 tokens
    const amountOrFlowratePerHour = (Math.random() * 10 * 1e18).toString();

    try {
        await selectedFunction.fn(amountOrFlowratePerHour);
    } catch (e) {
        console.error(`${selectedFunction.fn.name} failed: ${e}`);
    }
    printBalances(superToken, [
        { address: senderSigner.address, label: "sender" },
        { address: receiverSigner.address, label: "receiver" }
    ]);

    const adminBalance = await adminSigner.getBalance();
    if (adminBalance.lt(minBalance)) {
        console.warn(`admin balance low: ${e.utils.formatEther(adminBalance)}}`);
    }
    const senderBalance = await senderSigner.getBalance();
    if (senderBalance.lt(minBalance)) {
        console.warn(`sender balance low: ${e.utils.formatEther(senderBalance)}}`);
    }
}

init()
  .then(() => {
    // start loop
    setInterval(doSomething, parseInt(actionIntervalS) * 1000);
    //process.exit(0))
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });

// add a webserver listening for additional ad-hoc commands for targeted debugging
const port = process.env.PORT || 3000 + instanceId;
const express = require("express");
const app = express();
app.get('/:method', async (req, res) => {
    const method = req.params.method;
    let amount = req.query.amount;

    const doFunction = doFunctions.find(item => item.fn.name === method);
    if (doFunction === undefined) {
        console.error(`unsupported method: ${method}`);
        res.status(400).send(`Unsupported method: ${method}. Can be one of: ${doFunctions.map(f => f.fn.name)}`);
        return;
    }

    if (amount === undefined || isNaN(amount)) {
        amount = (Math.random() * 10 * 1e18).toString();
        console.log(`amount not provided or not a number, choosing random amount ${amount}`);
    }

    const tx = await doFunction.fn(amount);
    console.log(`tx: ${JSON.stringify(tx)}`);

    res.status(200).send(tx.hash);
});

(async () => {
    app.listen(port, () => {
        console.log(`Server listening on port ${port}`);
    });
})();