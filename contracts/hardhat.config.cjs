const { HardhatUserConfig } = require("hardhat/config");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const config = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
  },
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
      accounts: process.env.WALLET_PRIVATE_KEY
        ? [process.env.WALLET_PRIVATE_KEY]
        : undefined,
    },
  },
};

module.exports = config;
