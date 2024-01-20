import { ethers, network } from "hardhat";
import { verify } from "../utils/verify";
import { Contract } from "ethers";

// Set DAOracle address
const DAOracleAddr = "0x3a5cbB6EF4756DA0b3f6DAE7aB6430fD8c46d247";

const main = async () => {
    // Log network name and chain id selected for deployment
    const chainIdHex = await network.provider.send("eth_chainId");
    const chainId = parseInt(chainIdHex, 16);
    console.log("Network name:", network.name);
    console.log("Network chain id:", chainId + "\n");

    // Get deployer/signer account
    const [owner, publisher] = await ethers.getSigners();
    const ownerAddr = await owner.getAddress();
    const publisherAddr = await publisher.getAddress();

    console.log("Owner address is set to:", ownerAddr);
    console.log("Publisher address is set to:", publisherAddr);
    console.log("DAOracle address set to:", DAOracleAddr + "\n");

    // Add new provider for pegasus rpc
    const pegasus = new ethers.JsonRpcProvider(process.env.PEGASUS_PROVIDER_URL);

    // Call pegasus rpc to get the latest blocks state root
    const latestBlock = await pegasus.provider.send('eth_getBlockByNumber', ["latest", true]);
    console.log("Latest L2 block number for L1 genesis:", parseInt(latestBlock?.number, 16));
    console.log("Latest L2 block hash for L1 genesis:", latestBlock?.hash);
    console.log("Latest L2 block state root for L1 genesis:", latestBlock?.stateRoot + "\n");

    // Build genesis header from latest L2 block
    const genesisHeader = {
        epoch: 0,
        l2Height: parseInt(latestBlock?.number, 16),
        prevHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        txRoot: ethers.keccak256(ethers.toUtf8Bytes("0")),
        blockRoot: latestBlock?.hash,
        stateRoot: latestBlock?.stateRoot, // fix state root
        celestiaHeight: 0,
        celestiaDataRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };

    ///
    /// Deploy contracts
    ///

    // Deploy CanonicalStateChain contract
    console.log("Deploying CanonicalStateChain...");
    const CanonicalStateChain = await ethers.getContractFactory("CanonicalStateChain");
    const canonicalStateChain = await CanonicalStateChain.deploy(publisherAddr, genesisHeader);
    await canonicalStateChain.waitForDeployment();
    const canonicalStateChainAddr = await canonicalStateChain.getAddress();
    console.log(`→ CanonicalStateChain deployed to ${canonicalStateChainAddr}`);

    // Deploy Treasury contract
    console.log("Deploying Treasury...");
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy();
    await treasury.waitForDeployment();
    const treasuryAddr = await treasury.getAddress();
    console.log(`→ Treasury deployed to ${treasuryAddr}`);

    // Deploy Challenge contract as a proxy
    console.log("Deploying Challenge...");
    const proxyFactory: any = await ethers.getContractFactory("CoreProxy");
    const challengeFactory: any = await ethers.getContractFactory("Challenge");
    const challengeImplementation = await challengeFactory.deploy();
    await challengeImplementation.waitForDeployment();
    const challengeImplementationAddr = await challengeImplementation.getAddress();

    const proxy = await proxyFactory.deploy(
        challengeImplementationAddr,
        challengeImplementation.interface.encodeFunctionData("initialize", [
            treasuryAddr,
            await canonicalStateChain.getAddress(),
            DAOracleAddr,
            ethers.ZeroAddress,
        ])
    );
    await proxy.waitForDeployment();
    const challenge = challengeFactory.attach(await proxy.getAddress());
    const challengeContractAddr = await challenge.getAddress();
    console.log(`→ Challenge proxy deployed to ${challengeContractAddr}`);
    console.log(`→ Challenge implementation deployed to ${challengeImplementationAddr}`);

    ///
    /// Set contract setters
    ///

    // set Challenge.setDefender() to publisherAddr
    await challenge.setDefender(publisherAddr);
    console.log(`→ → Challenge.setDefender() set to ${publisherAddr}`);

    // set CanonicalStateChain.challengeContract() to challengeContractAddr
    await canonicalStateChain.setChallengeContract(challengeContractAddr);
    console.log(`→ → CanonicalStateChain.challengeContract() set to ${challengeContractAddr}` + "\n");

    console.log("All Contracts deployed successfully! \n");

    ///
    /// Verify contracts
    ///

    // Verify contract (after 1 min)
    console.log("Waiting for 1 min before verifying contracts..");
    await new Promise((r) => setTimeout(r, 60000));

    // Verify CanonicalStateChain
    await verify(canonicalStateChainAddr, [publisherAddr, genesisHeader], "contracts/CanonicalStateChain.sol:CanonicalStateChain");
    console.log(`Verified CanonicalStateChain contract at ${canonicalStateChainAddr}`);

    // Verify Treasury
    await verify(treasuryAddr, [], "contracts/Treasury.sol:Treasury");

    // Verify Challenge Implementation
    await verify(challengeImplementationAddr, [], "contracts/challenge/Challenge.sol:Challenge");
    console.log(`Verified Challenge impl contract at ${challengeImplementationAddr}`);

    // Verify Proxy
    await verify(challengeContractAddr, [await challengeImplementation.getAddress(), challengeImplementation.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
        canonicalStateChainAddr,
        DAOracleAddr,
        ethers.ZeroAddress,
    ])], "contracts/proxy/CoreProxy.sol:CoreProxy");

};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
