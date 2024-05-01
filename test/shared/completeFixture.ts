import { v3RouterFixture } from './externalFixtures'
import { constants } from 'ethers'
import {
  IWETH9,
  MockTimeNonfungiblePositionManager,
  MockTimeSwapRouter,
  TestERC20,
  IUniswapV3Factory,
} from '../../typechain'
import { Wallet, Contract } from 'zksync-web3'
import { deployContract } from './zkSyncUtils'

export let nftDescriptorLibrary: Contract | undefined

async function completeFixture([wallet]: Wallet[]): Promise<{
  weth9: IWETH9
  factory: IUniswapV3Factory
  router: MockTimeSwapRouter
  nft: MockTimeNonfungiblePositionManager
  nftDescriptor: Contract
  tokens: [TestERC20, TestERC20, TestERC20]
}> {
  const { weth9, factory, router } = await v3RouterFixture([wallet])

  const tokens: [TestERC20, TestERC20, TestERC20] = [
    (await deployContract(wallet, 'TestERC20', [constants.MaxUint256.div(2)])) as TestERC20, // do not use maxu256 to avoid overflowing
    (await deployContract(wallet, 'TestERC20', [constants.MaxUint256.div(2)])) as TestERC20,
    (await deployContract(wallet, 'TestERC20', [constants.MaxUint256.div(2)])) as TestERC20,
  ]

  if (nftDescriptorLibrary === undefined) {
    nftDescriptorLibrary = await deployContract(wallet, 'NFTDescriptor')

    const hre = require('hardhat')
    hre.config.zksolc.settings.libraries = {
      'contracts/libraries/NFTDescriptor.sol': {
        NFTDescriptor: nftDescriptorLibrary.address,
      },
    }
    await hre.run('compile')
  }
  const nftDescriptor = await deployContract(wallet, 'NonfungibleTokenPositionDescriptor', [
    tokens[0].address,
    // 'ETH' as a bytes32 string
    '0x4554480000000000000000000000000000000000000000000000000000000000',
  ])

  const nft = (await deployContract(wallet, 'MockTimeNonfungiblePositionManager', [
    factory.address,
    weth9.address,
    nftDescriptor.address,
  ])) as MockTimeNonfungiblePositionManager

  tokens.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))

  return {
    weth9,
    factory,
    router,
    tokens,
    nft,
    nftDescriptor,
  }
}

export default completeFixture
