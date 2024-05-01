import "@matterlabs/hardhat-zksync-deploy";
import "@matterlabs/hardhat-zksync-solc";
import "@matterlabs/hardhat-zksync-verify";
import "@nomiclabs/hardhat-ethers";

export default  {
    zksolc: {
      version: 'latest',
      compilerSource: 'binary',
      settings: {
        metadata: {
          bytecodeHash: 'none',
        },
        libraries: {
          'contracts/periphery/libraries/NFTDescriptor.sol': {
            NFTDescriptor: "0xfd26c2511B0cfc4a486437aA772D1B79008F530F",
          },
        }
      },
    },
    defaultNetwork: "zkSyncLocal",
    solidity: {
      version: '0.7.6',
      settings: {
        metadata: {
          // do not include the metadata hash, since this is machine dependent
          // and we want all generated code to be deterministic
          // https://docs.soliditylang.org/en/v0.7.6/metadata.html
          bytecodeHash: 'none',
        },
      },
    },
    mocha: {
      timeout: 100000000
    },
    networks: {
      zkSyncTestnet: {
        url: "https://sepolia.era.zksync.dev",
        ethNetwork: "sepolia",
        zksync: true,
        allowUnlimitedContractSize: true
      },
      zkSyncLocal: {
        // Using 127.0.0.1 instead of localhost is necessary for CI builds
        url: "http://127.0.0.1:8011",
        // ethNetwork isn't necessary, but leaving for posterity
        ethNetwork: "localhost",
        zksync: true,
      },
      zkSyncMainnet: {
        url: "https://mainnet.era.zksync.io",
        ethNetwork: "mainnet",
        zksync: true,
        allowUnlimitedContractSize: true,
        verifyURL: 'https://zksync2-mainnet-explorer.zksync.io/contract_verification'
      },
      hardhat: {
        zksync: true,
        allowUnlimitedContractSize: true
      },
    },

};



