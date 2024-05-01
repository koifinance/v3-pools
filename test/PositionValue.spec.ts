import { waffle, ethers } from 'hardhat'
import { constants, BigNumberish } from 'ethers'
import { Contract } from 'zksync-web3'
import { Fixture } from 'ethereum-waffle'
import {
  PositionValueTest,
  SwapRouter,
  MockTimeNonfungiblePositionManager,
  IUniswapV3Pool,
  TestERC20,
  IUniswapV3Factory,
} from '../typechain'
import { FeeAmount, MaxUint128, TICK_SPACINGS } from './shared/constants'
import { getMaxTick, getMinTick } from './shared/ticks'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { encodePath } from './shared/path'
import { computePoolAddress } from './shared/computePoolAddress'
import completeFixture from './shared/completeFixture'
import snapshotGasCost from './shared/snapshotGasCost'

import { expect } from './shared/expect'

import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts-zk/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'

import { deployContract, getWallets } from './shared/zkSyncUtils'
import { Wallet } from 'zksync-web3'

describe('PositionValue', async () => {
  const [...wallets] = getWallets()
  async function positionValueCompleteFixture([wallet]: Wallet[]): Promise<{
    positionValue: PositionValueTest
    tokens: [TestERC20, TestERC20, TestERC20]
    nft: MockTimeNonfungiblePositionManager
    router: SwapRouter
    factory: IUniswapV3Factory
  }> {
    const { nft, router, tokens, factory } = await completeFixture([wallet])
    const positionValue = (await deployContract(wallet, 'PositionValueTest')) as PositionValueTest

    for (const token of tokens) {
      await (await token.approve(nft.address, constants.MaxUint256)).wait()
      await (await (token as any).connect(wallets[0]).approve(nft.address, constants.MaxUint256)).wait()
      await (await token.transfer(wallets[0].address, expandTo18Decimals(1_000_000))).wait()
    }

    return {
      positionValue,
      tokens,
      nft,
      router,
      factory,
    }
  }

  let pool: Contract
  let tokens: [TestERC20, TestERC20, TestERC20]
  let positionValue: PositionValueTest
  let nft: MockTimeNonfungiblePositionManager
  let router: SwapRouter
  let factory: IUniswapV3Factory

  let amountDesired: BigNumberish

  beforeEach(async () => {
    ;({ positionValue, tokens, nft, router, factory } = await positionValueCompleteFixture(wallets))
    await (
      await nft.createAndInitializePoolIfNecessary(
        tokens[0].address,
        tokens[1].address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )
    ).wait()

    const poolAddress = computePoolAddress(factory.address, [tokens[0].address, tokens[1].address], FeeAmount.MEDIUM)
    pool = new Contract(poolAddress, IUniswapV3PoolABI, wallets[0] as any)
  })

  describe('#total', () => {
    let tokenId: number
    let sqrtRatioX96: BigNumberish

    beforeEach(async () => {
      amountDesired = expandTo18Decimals(100_000)

      await (
        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallets[0].address,
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      ).wait()

      const swapAmount = expandTo18Decimals(1_000)
      await (await tokens[0].approve(router.address, swapAmount)).wait()
      await (await tokens[1].approve(router.address, swapAmount)).wait()

      // accmuluate token0 fees
      await (
        await router.exactInput({
          recipient: wallets[0].address,
          deadline: 1,
          path: encodePath([tokens[0].address, tokens[1].address], [FeeAmount.MEDIUM]),
          amountIn: swapAmount,
          amountOutMinimum: 0,
        })
      ).wait()

      // accmuluate token1 fees
      await (
        await router.exactInput({
          recipient: wallets[0].address,
          deadline: 1,
          path: encodePath([tokens[1].address, tokens[0].address], [FeeAmount.MEDIUM]),
          amountIn: swapAmount,
          amountOutMinimum: 0,
        })
      ).wait()

      sqrtRatioX96 = (await pool.slot0()).sqrtPriceX96
    })

    it('returns the correct amount', async () => {
      const principal = await positionValue.principal(nft.address, 1, sqrtRatioX96)
      const fees = await positionValue.fees(nft.address, 1)
      const total = await positionValue.total(nft.address, 1, sqrtRatioX96)

      expect(total[0]).to.equal(principal[0].add(fees[0]))
      expect(total[1]).to.equal(principal[1].add(fees[1]))
    })

    it('gas', async () => {
      await snapshotGasCost(positionValue.totalGas(nft.address, 1, sqrtRatioX96))
    })
  })

  describe('#principal', () => {
    let sqrtRatioX96: BigNumberish

    beforeEach(async () => {
      amountDesired = expandTo18Decimals(100_000)
      sqrtRatioX96 = (await pool.slot0()).sqrtPriceX96
    })

    it('returns the correct values when price is in the middle of the range', async () => {
      await (
        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallets[0].address,
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      ).wait()

      const principal = await positionValue.principal(nft.address, 1, sqrtRatioX96)
      expect(principal.amount0).to.equal('99999999999999999999999')
      expect(principal.amount1).to.equal('99999999999999999999999')
    })

    it('returns the correct values when range is below current price', async () => {
      await (
        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: -60,
          fee: FeeAmount.MEDIUM,
          recipient: wallets[0].address,
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      ).wait()

      const principal = await positionValue.principal(nft.address, 1, sqrtRatioX96)
      expect(principal.amount0).to.equal('0')
      expect(principal.amount1).to.equal('99999999999999999999999')
    })

    it('returns the correct values when range is below current price', async () => {
      await (
        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: 60,
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallets[0].address,
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      ).wait()

      const principal = await positionValue.principal(nft.address, 1, sqrtRatioX96)
      expect(principal.amount0).to.equal('99999999999999999999999')
      expect(principal.amount1).to.equal('0')
    })

    it('returns the correct values when range is skewed above price', async () => {
      await (
        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: -6_000,
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallets[0].address,
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      ).wait()

      const principal = await positionValue.principal(nft.address, 1, sqrtRatioX96)
      expect(principal.amount0).to.equal('99999999999999999999999')
      expect(principal.amount1).to.equal('25917066770240321655335')
    })

    it('returns the correct values when range is skewed below price', async () => {
      await (
        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: 6_000,
          fee: FeeAmount.MEDIUM,
          recipient: wallets[0].address,
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      ).wait()

      const principal = await positionValue.principal(nft.address, 1, sqrtRatioX96)
      expect(principal.amount0).to.equal('25917066770240321655335')
      expect(principal.amount1).to.equal('99999999999999999999999')
    })

    it('gas', async () => {
      await (
        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallets[0].address,
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      ).wait()

      await snapshotGasCost(positionValue.principalGas(nft.address, 1, sqrtRatioX96))
    })
  })

  describe('#fees', () => {
    let tokenId: number

    beforeEach(async () => {
      amountDesired = expandTo18Decimals(100_000)
      tokenId = 2

      await (
        await nft.mint({
          token0: tokens[0].address,
          token1: tokens[1].address,
          tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
          fee: FeeAmount.MEDIUM,
          recipient: wallets[0].address,
          amount0Desired: amountDesired,
          amount1Desired: amountDesired,
          amount0Min: 0,
          amount1Min: 0,
          deadline: 10,
        })
      ).wait()
    })

    describe('when price is within the position range', () => {
      beforeEach(async () => {
        await (
          await nft.mint({
            token0: tokens[0].address,
            token1: tokens[1].address,
            tickLower: TICK_SPACINGS[FeeAmount.MEDIUM] * -1_000,
            tickUpper: TICK_SPACINGS[FeeAmount.MEDIUM] * 1_000,
            fee: FeeAmount.MEDIUM,
            recipient: wallets[0].address,
            amount0Desired: amountDesired,
            amount1Desired: amountDesired,
            amount0Min: 0,
            amount1Min: 0,
            deadline: 10,
          })
        ).wait()

        const swapAmount = expandTo18Decimals(1_000)
        await (await tokens[0].approve(router.address, swapAmount)).wait()
        await (await tokens[1].approve(router.address, swapAmount)).wait()

        // accmuluate token0 fees
        await (
          await router.exactInput({
            recipient: wallets[0].address,
            deadline: 1,
            path: encodePath([tokens[0].address, tokens[1].address], [FeeAmount.MEDIUM]),
            amountIn: swapAmount,
            amountOutMinimum: 0,
          })
        ).wait()

        // accmuluate token1 fees
        await (
          await router.exactInput({
            recipient: wallets[0].address,
            deadline: 1,
            path: encodePath([tokens[1].address, tokens[0].address], [FeeAmount.MEDIUM]),
            amountIn: swapAmount,
            amountOutMinimum: 0,
          })
        ).wait()
      })

      it('return the correct amount of fees', async () => {
        const feesFromCollect = await nft.callStatic.collect({
          tokenId,
          recipient: wallets[0].address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
        const feeAmounts = await positionValue.fees(nft.address, tokenId)

        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('returns the correct amount of fees if tokensOwed fields are greater than 0', async () => {
        await (
          await nft.increaseLiquidity({
            tokenId: tokenId,
            amount0Desired: 100,
            amount1Desired: 100,
            amount0Min: 0,
            amount1Min: 0,
            deadline: 1,
          })
        ).wait()

        const swapAmount = expandTo18Decimals(1_000)
        await (await tokens[0].approve(router.address, swapAmount)).wait()

        // accmuluate more token0 fees after clearing initial amount
        await (
          await router.exactInput({
            recipient: wallets[0].address,
            deadline: 1,
            path: encodePath([tokens[0].address, tokens[1].address], [FeeAmount.MEDIUM]),
            amountIn: swapAmount,
            amountOutMinimum: 0,
          })
        ).wait()

        const feesFromCollect = await nft.callStatic.collect({
          tokenId,
          recipient: wallets[0].address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
        const feeAmounts = await positionValue.fees(nft.address, tokenId)
        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('gas', async () => {
        await snapshotGasCost(positionValue.feesGas(nft.address, tokenId))
      })
    })

    describe('when price is below the position range', async () => {
      beforeEach(async () => {
        await (
          await nft.mint({
            token0: tokens[0].address,
            token1: tokens[1].address,
            tickLower: TICK_SPACINGS[FeeAmount.MEDIUM] * -10,
            tickUpper: TICK_SPACINGS[FeeAmount.MEDIUM] * 10,
            fee: FeeAmount.MEDIUM,
            recipient: wallets[0].address,
            amount0Desired: expandTo18Decimals(10_000),
            amount1Desired: expandTo18Decimals(10_000),
            amount0Min: 0,
            amount1Min: 0,
            deadline: 10,
          })
        ).wait()

        await (await tokens[0].approve(router.address, constants.MaxUint256)).wait()
        await (await tokens[1].approve(router.address, constants.MaxUint256)).wait()

        // accumulate token1 fees
        await (
          await router.exactInput({
            recipient: wallets[0].address,
            deadline: 1,
            path: encodePath([tokens[1].address, tokens[0].address], [FeeAmount.MEDIUM]),
            amountIn: expandTo18Decimals(1_000),
            amountOutMinimum: 0,
          })
        ).wait()

        // accumulate token0 fees and push price below tickLower
        await (
          await router.exactInput({
            recipient: wallets[0].address,
            deadline: 1,
            path: encodePath([tokens[0].address, tokens[1].address], [FeeAmount.MEDIUM]),
            amountIn: expandTo18Decimals(50_000),
            amountOutMinimum: 0,
          })
        ).wait()
      })

      it('returns the correct amount of fees', async () => {
        const feesFromCollect = await nft.callStatic.collect({
          tokenId,
          recipient: wallets[0].address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })

        const feeAmounts = await positionValue.fees(nft.address, tokenId)
        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('gas', async () => {
        await snapshotGasCost(positionValue.feesGas(nft.address, tokenId))
      })
    })

    describe('when price is above the position range', async () => {
      beforeEach(async () => {
        await (
          await nft.mint({
            token0: tokens[0].address,
            token1: tokens[1].address,
            tickLower: TICK_SPACINGS[FeeAmount.MEDIUM] * -10,
            tickUpper: TICK_SPACINGS[FeeAmount.MEDIUM] * 10,
            fee: FeeAmount.MEDIUM,
            recipient: wallets[0].address,
            amount0Desired: expandTo18Decimals(10_000),
            amount1Desired: expandTo18Decimals(10_000),
            amount0Min: 0,
            amount1Min: 0,
            deadline: 10,
          })
        ).wait()

        await (await tokens[0].approve(router.address, constants.MaxUint256)).wait()
        await (await tokens[1].approve(router.address, constants.MaxUint256)).wait()

        // accumulate token0 fees
        await (
          await router.exactInput({
            recipient: wallets[0].address,
            deadline: 1,
            path: encodePath([tokens[0].address, tokens[1].address], [FeeAmount.MEDIUM]),
            amountIn: expandTo18Decimals(1_000),
            amountOutMinimum: 0,
          })
        ).wait()

        // accumulate token1 fees and push price above tickUpper
        await (
          await router.exactInput({
            recipient: wallets[0].address,
            deadline: 1,
            path: encodePath([tokens[1].address, tokens[0].address], [FeeAmount.MEDIUM]),
            amountIn: expandTo18Decimals(50_000),
            amountOutMinimum: 0,
          })
        ).wait()
      })

      it('returns the correct amount of fees', async () => {
        const feesFromCollect = await nft.callStatic.collect({
          tokenId,
          recipient: wallets[0].address,
          amount0Max: MaxUint128,
          amount1Max: MaxUint128,
        })
        const feeAmounts = await positionValue.fees(nft.address, tokenId)
        expect(feeAmounts[0]).to.equal(feesFromCollect[0])
        expect(feeAmounts[1]).to.equal(feesFromCollect[1])
      })

      it('gas', async () => {
        await snapshotGasCost(positionValue.feesGas(nft.address, tokenId))
      })
    })
  })
})