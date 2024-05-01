import { constants } from 'ethers'
import { Contract, Wallet } from 'zksync-web3'
import {
  IUniswapV2Pair,
  IUniswapV3Factory,
  IWETH9,
  MockTimeNonfungiblePositionManager,
  TestERC20,
  V3Migrator,
} from '../typechain'
import completeFixture from './shared/completeFixture'
import { v2FactoryFixture } from './shared/externalFixtures'

import { abi as PAIR_V2_ABI } from '@uniswap/v2-core/artifacts-zk/contracts/UniswapV2Pair.sol/UniswapV2Pair.json'
import { expect } from 'chai'
import { FeeAmount } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import snapshotGasCost from './shared/snapshotGasCost'
import { sortedTokens } from './shared/tokenSort'
import { getMaxTick, getMinTick } from './shared/ticks'

import { getWallets, deployContract, provider } from './shared/zkSyncUtils'

describe('V3Migrator', () => {
  let wallet: Wallet

  async function migratorFixture([wallet]: Wallet[]): Promise<{
    factoryV2: Contract
    factoryV3: IUniswapV3Factory
    token: TestERC20
    weth9: IWETH9
    nft: MockTimeNonfungiblePositionManager
    migrator: V3Migrator
  }> {
    const { factory, tokens, nft, weth9 } = await completeFixture([wallet])

    const { factory: factoryV2 } = await v2FactoryFixture([wallet])

    const token = tokens[0]
    await (await token.approve(factoryV2.address, constants.MaxUint256)).wait()
    await (await weth9.deposit({ value: 10000 })).wait()
    await (await weth9.approve(nft.address, constants.MaxUint256)).wait()

    // deploy the migrator
    const migrator = (await deployContract(wallet, 'V3Migrator', [
      factory.address,
      weth9.address,
      nft.address,
    ])) as V3Migrator

    return {
      factoryV2,
      factoryV3: factory,
      token,
      weth9,
      nft,
      migrator,
    }
  }

  let factoryV2: Contract
  let factoryV3: IUniswapV3Factory
  let token: TestERC20
  let weth9: IWETH9
  let nft: MockTimeNonfungiblePositionManager
  let migrator: V3Migrator
  let pair: IUniswapV2Pair

  const expectedLiquidity = 10000 - 1000

  before('create fixture loader', async () => {
    const wallets = getWallets()
    wallet = wallets[0]
  })

  beforeEach('load fixture', async () => {
    ;({ factoryV2, factoryV3, token, weth9, nft, migrator } = await migratorFixture([wallet]))
  })

  beforeEach('add V2 liquidity', async () => {
    await (await factoryV2.createPair(token.address, weth9.address)).wait()

    const pairAddress = await factoryV2.getPair(token.address, weth9.address)

    pair = new Contract(pairAddress, PAIR_V2_ABI, wallet as any) as IUniswapV2Pair

    await (await token.transfer(pair.address, 10000)).wait()
    await (await weth9.transfer(pair.address, 10000)).wait()

    await (await pair.mint(wallet.address)).wait()

    expect(await pair.balanceOf(wallet.address)).to.be.eq(expectedLiquidity)
  })

  afterEach('ensure allowances are cleared', async () => {
    const allowanceToken = await token.allowance(migrator.address, nft.address)
    const allowanceWETH9 = await weth9.allowance(migrator.address, nft.address)
    expect(allowanceToken).to.be.eq(0)
    expect(allowanceWETH9).to.be.eq(0)
  })

  afterEach('ensure balances are cleared', async () => {
    const balanceToken = await token.balanceOf(migrator.address)
    const balanceWETH9 = await weth9.balanceOf(migrator.address)
    expect(balanceToken).to.be.eq(0)
    expect(balanceWETH9).to.be.eq(0)
  })

  afterEach('ensure eth balance is cleared', async () => {
    const balanceETH = await provider.getBalance(migrator.address)
    expect(balanceETH).to.be.eq(0)
  })

  describe('#migrate', () => {
    let tokenLower: boolean
    beforeEach(() => {
      tokenLower = token.address.toLowerCase() < weth9.address.toLowerCase()
    })

    it('fails if v3 pool is not initialized', async () => {
      await (await pair.approve(migrator.address, expectedLiquidity)).wait()
      await expect(
        migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : weth9.address,
          token1: tokenLower ? weth9.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: -1,
          tickUpper: 1,
          amount0Min: 9000,
          amount1Min: 9000,
          recipient: wallet.address,
          deadline: 1,
          refundAsETH: false,
        })
      ).to.be.reverted
    })

    it('works once v3 pool is initialized', async () => {
      const [token0, token1] = sortedTokens(weth9, token)
      await (
        await migrator.createAndInitializePoolIfNecessary(
          token0.address,
          token1.address,
          FeeAmount.MEDIUM,
          encodePriceSqrt(1, 1)
        )
      ).wait()

      await (await pair.approve(migrator.address, expectedLiquidity)).wait()
      await (
        await migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : weth9.address,
          token1: tokenLower ? weth9.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 9000,
          amount1Min: 9000,
          recipient: wallet.address,
          deadline: 1,
          refundAsETH: false,
        })
      ).wait()

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(9000)

      const poolAddress = await factoryV3.getPool(token.address, weth9.address, FeeAmount.MEDIUM)
      expect(await token.balanceOf(poolAddress)).to.be.eq(9000)
      expect(await weth9.balanceOf(poolAddress)).to.be.eq(9000)
    })

    it('works for partial', async () => {
      const [token0, token1] = sortedTokens(weth9, token)
      await (
        await migrator.createAndInitializePoolIfNecessary(
          token0.address,
          token1.address,
          FeeAmount.MEDIUM,
          encodePriceSqrt(1, 1)
        )
      ).wait()

      const tokenBalanceBefore = await token.balanceOf(wallet.address)
      const weth9BalanceBefore = await weth9.balanceOf(wallet.address)

      await (await pair.approve(migrator.address, expectedLiquidity)).wait()
      await (
        await migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 50,
          token0: tokenLower ? token.address : weth9.address,
          token1: tokenLower ? weth9.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 4500,
          amount1Min: 4500,
          recipient: wallet.address,
          deadline: 1,
          refundAsETH: false,
        })
      ).wait()

      const tokenBalanceAfter = await token.balanceOf(wallet.address)
      const weth9BalanceAfter = await weth9.balanceOf(wallet.address)

      expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
      expect(weth9BalanceAfter.sub(weth9BalanceBefore)).to.be.eq(4500)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(4500)

      const poolAddress = await factoryV3.getPool(token.address, weth9.address, FeeAmount.MEDIUM)
      expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
      expect(await weth9.balanceOf(poolAddress)).to.be.eq(4500)
    })

    it('double the price', async () => {
      const [token0, token1] = sortedTokens(weth9, token)
      await (
        await migrator.createAndInitializePoolIfNecessary(
          token0.address,
          token1.address,
          FeeAmount.MEDIUM,
          encodePriceSqrt(2, 1)
        )
      ).wait()

      const tokenBalanceBefore = await token.balanceOf(wallet.address)
      const weth9BalanceBefore = await weth9.balanceOf(wallet.address)

      await (await pair.approve(migrator.address, expectedLiquidity)).wait()
      await (
        await migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : weth9.address,
          token1: tokenLower ? weth9.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 4500,
          amount1Min: 8999,
          recipient: wallet.address,
          deadline: 1,
          refundAsETH: false,
        })
      ).wait()

      const tokenBalanceAfter = await token.balanceOf(wallet.address)
      const weth9BalanceAfter = await weth9.balanceOf(wallet.address)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(6363)

      const poolAddress = await factoryV3.getPool(token.address, weth9.address, FeeAmount.MEDIUM)
      if (token.address.toLowerCase() < weth9.address.toLowerCase()) {
        expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
        expect(await weth9.balanceOf(poolAddress)).to.be.eq(8999)
        expect(weth9BalanceAfter.sub(weth9BalanceBefore)).to.be.eq(1)
      } else {
        expect(await token.balanceOf(poolAddress)).to.be.eq(8999)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(1)
        expect(await weth9.balanceOf(poolAddress)).to.be.eq(4500)
        expect(weth9BalanceAfter.sub(weth9BalanceBefore)).to.be.eq(4500)
      }
    })

    it('half the price', async () => {
      const [token0, token1] = sortedTokens(weth9, token)
      await (
        await migrator.createAndInitializePoolIfNecessary(
          token0.address,
          token1.address,
          FeeAmount.MEDIUM,
          encodePriceSqrt(1, 2)
        )
      ).wait()

      const tokenBalanceBefore = await token.balanceOf(wallet.address)
      const weth9BalanceBefore = await weth9.balanceOf(wallet.address)

      await (await pair.approve(migrator.address, expectedLiquidity)).wait()
      await (
        await migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : weth9.address,
          token1: tokenLower ? weth9.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 8999,
          amount1Min: 4500,
          recipient: wallet.address,
          deadline: 1,
          refundAsETH: false,
        })
      ).wait()

      const tokenBalanceAfter = await token.balanceOf(wallet.address)
      const weth9BalanceAfter = await weth9.balanceOf(wallet.address)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(6363)

      const poolAddress = await factoryV3.getPool(token.address, weth9.address, FeeAmount.MEDIUM)
      if (token.address.toLowerCase() < weth9.address.toLowerCase()) {
        expect(await token.balanceOf(poolAddress)).to.be.eq(8999)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(1)
        expect(await weth9.balanceOf(poolAddress)).to.be.eq(4500)
        expect(weth9BalanceAfter.sub(weth9BalanceBefore)).to.be.eq(4500)
      } else {
        expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
        expect(await weth9.balanceOf(poolAddress)).to.be.eq(8999)
        expect(weth9BalanceAfter.sub(weth9BalanceBefore)).to.be.eq(1)
      }
    })

    it('double the price - as ETH', async () => {
      const [token0, token1] = sortedTokens(weth9, token)
      await (
        await migrator.createAndInitializePoolIfNecessary(
          token0.address,
          token1.address,
          FeeAmount.MEDIUM,
          encodePriceSqrt(2, 1)
        )
      ).wait()

      const tokenBalanceBefore = await token.balanceOf(wallet.address)

      await (await pair.approve(migrator.address, expectedLiquidity)).wait()
      await expect(
        migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : weth9.address,
          token1: tokenLower ? weth9.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 4500,
          amount1Min: 8999,
          recipient: wallet.address,
          deadline: 1,
          refundAsETH: true,
        })
      )
        .to.emit(weth9, 'Transfer')
        .withArgs(migrator.address, '0x0000000000000000000000000000000000000000', tokenLower ? 1 : 4500)

      const tokenBalanceAfter = await token.balanceOf(wallet.address)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(6363)

      const poolAddress = await factoryV3.getPool(token.address, weth9.address, FeeAmount.MEDIUM)
      if (tokenLower) {
        expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
        expect(await weth9.balanceOf(poolAddress)).to.be.eq(8999)
      } else {
        expect(await token.balanceOf(poolAddress)).to.be.eq(8999)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(1)
        expect(await weth9.balanceOf(poolAddress)).to.be.eq(4500)
      }
    })

    it('half the price - as ETH', async () => {
      const [token0, token1] = sortedTokens(weth9, token)
      await (
        await migrator.createAndInitializePoolIfNecessary(
          token0.address,
          token1.address,
          FeeAmount.MEDIUM,
          encodePriceSqrt(1, 2)
        )
      ).wait()

      const tokenBalanceBefore = await token.balanceOf(wallet.address)

      await (await pair.approve(migrator.address, expectedLiquidity)).wait()
      await expect(
        migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : weth9.address,
          token1: tokenLower ? weth9.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 8999,
          amount1Min: 4500,
          recipient: wallet.address,
          deadline: 1,
          refundAsETH: true,
        })
      )
        .to.emit(weth9, 'Transfer')
        .withArgs(migrator.address, '0x0000000000000000000000000000000000000000', tokenLower ? 4500 : 1)

      const tokenBalanceAfter = await token.balanceOf(wallet.address)

      const position = await nft.positions(1)
      expect(position.liquidity).to.be.eq(6363)

      const poolAddress = await factoryV3.getPool(token.address, weth9.address, FeeAmount.MEDIUM)
      if (tokenLower) {
        expect(await token.balanceOf(poolAddress)).to.be.eq(8999)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(1)
        expect(await weth9.balanceOf(poolAddress)).to.be.eq(4500)
      } else {
        expect(await token.balanceOf(poolAddress)).to.be.eq(4500)
        expect(tokenBalanceAfter.sub(tokenBalanceBefore)).to.be.eq(4500)
        expect(await weth9.balanceOf(poolAddress)).to.be.eq(8999)
      }
    })

    it('gas', async () => {
      const [token0, token1] = sortedTokens(weth9, token)
      await (
        await migrator.createAndInitializePoolIfNecessary(
          token0.address,
          token1.address,
          FeeAmount.MEDIUM,
          encodePriceSqrt(1, 1)
        )
      ).wait()

      await (await pair.approve(migrator.address, expectedLiquidity)).wait()
      await snapshotGasCost(
        migrator.migrate({
          pair: pair.address,
          liquidityToMigrate: expectedLiquidity,
          percentageToMigrate: 100,
          token0: tokenLower ? token.address : weth9.address,
          token1: tokenLower ? weth9.address : token.address,
          fee: FeeAmount.MEDIUM,
          tickLower: getMinTick(FeeAmount.MEDIUM),
          tickUpper: getMaxTick(FeeAmount.MEDIUM),
          amount0Min: 9000,
          amount1Min: 9000,
          recipient: wallet.address,
          deadline: 1,
          refundAsETH: false,
        })
      )
    })
  })
})
