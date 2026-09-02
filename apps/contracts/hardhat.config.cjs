require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const config = {
  networks: {
    hardhat: {},
    localhost: {
      accounts: process.env.WALLET_PRIVATE_KEY
        ? [process.env.WALLET_PRIVATE_KEY]
        : undefined,
      url: "http://127.0.0.1:8545",
    },
  },
  solidity: {
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
    version: "0.8.24",
  },
};

module.exports = config;
