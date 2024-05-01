import { BigNumber, constants, ContractTransaction } from 'ethers'
import { Wallet, Contract } from 'zksync-web3'
import { IUniswapV3Pool, IWETH9, MockTimeSwapRouter, TestERC20 } from '../typechain'
import completeFixture from './shared/completeFixture'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { expect } from './shared/expect'
import { encodePath } from './shared/path'
import snapshotGasCost from './shared/snapshotGasCost'
import { getMaxTick, getMinTick } from './shared/ticks'

import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts-zk/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'

import { getWallets, deployContract } from './shared/zkSyncUtils'

describe('SwapRouter gas tests', function () {
  // this.timeout(40000)
  let wallet: Wallet
  let trader: Wallet

  async function swapRouterFixture([wallet]: Wallet[]): Promise<{
    weth9: IWETH9
    router: MockTimeSwapRouter
    tokens: [TestERC20, TestERC20, TestERC20]
    pools: [IUniswapV3Pool, IUniswapV3Pool, IUniswapV3Pool]
  }> {
    const { weth9, factory, router, tokens, nft } = await completeFixture([wallet])

    // approve & fund wallets
    for (const token of tokens) {
      await (await token.approve(router.address, constants.MaxUint256)).wait()
      await (await token.approve(nft.address, constants.MaxUint256)).wait()
      await (await (token as any).connect(trader).approve(router.address, constants.MaxUint256)).wait()
      await (await token.transfer(trader.address, expandTo18Decimals(1_000_000))).wait()
    }

    const liquidity = 1000000
    async function createPool(tokenAddressA: string, tokenAddressB: string) {
      if (tokenAddressA.toLowerCase() > tokenAddressB.toLowerCase())
        [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA]

      await (
        await nft.createAndInitializePoolIfNecessary(
          tokenAddressA,
          tokenAddressB,
          FeeAmount.MEDIUM,
          encodePriceSqrt(100005, 100000) // we don't want to cross any ticks
        )
      ).wait()

      const liquidityParams = {
        token0: tokenAddressA,
        token1: tokenAddressB,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address,
        amount0Desired: 1000000,
        amount1Desired: 1000000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      }

      return nft.mint(liquidityParams)
    }

    async function createPoolWETH9(tokenAddress: string) {
      await (await weth9.deposit({ value: liquidity * 2 })).wait()
      await (await weth9.approve(nft.address, constants.MaxUint256)).wait()
      return createPool(weth9.address, tokenAddress)
    }

    // create pools
    await (await createPool(tokens[0].address, tokens[1].address)).wait()
    await (await createPool(tokens[1].address, tokens[2].address)).wait()
    await (await createPoolWETH9(tokens[0].address)).wait()

    const poolAddresses = await Promise.all([
      factory.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM),
      factory.getPool(tokens[1].address, tokens[2].address, FeeAmount.MEDIUM),
      factory.getPool(weth9.address, tokens[0].address, FeeAmount.MEDIUM),
    ])

    const pools = poolAddresses.map((poolAddress) => new Contract(poolAddress, IUniswapV3PoolABI, wallet as any)) as [
      IUniswapV3Pool,
      IUniswapV3Pool,
      IUniswapV3Pool
    ]

    return {
      weth9,
      router,
      tokens,
      pools,
    }
  }

  let weth9: IWETH9
  let router: MockTimeSwapRouter
  let tokens: [TestERC20, TestERC20, TestERC20]
  let pools: [IUniswapV3Pool, IUniswapV3Pool, IUniswapV3Pool]

  before('create fixture loader', async () => {
    const wallets = getWallets()
    ;[wallet, trader] = wallets
  })

  beforeEach('load fixture', async () => {
    ;({ router, weth9, tokens, pools } = await swapRouterFixture([wallet]))
  })

  async function exactInput(
    tokens: string[],
    amountIn: number = 2,
    amountOutMinimum: number = 1
  ): Promise<ContractTransaction> {
    const inputIsWETH = weth9.address === tokens[0]
    const outputIsWETH9 = tokens[tokens.length - 1] === weth9.address

    const value = inputIsWETH ? amountIn : 0

    const params = {
      path: encodePath(tokens, new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
      recipient: outputIsWETH9 ? constants.AddressZero : trader.address,
      deadline: 1,
      amountIn,
      amountOutMinimum,
    }

    const data = [router.interface.encodeFunctionData('exactInput', [params])]
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, trader.address]))

    // optimized for the gas test
    return data.length === 1
      ? (router as any).connect(trader).exactInput(params, { value })
      : (router as any).connect(trader).multicall(data, { value })
  }

  async function exactInputSingle(
    tokenIn: string,
    tokenOut: string,
    amountIn: number = 3,
    amountOutMinimum: number = 1,
    sqrtPriceLimitX96?: BigNumber
  ): Promise<ContractTransaction> {
    const inputIsWETH = weth9.address === tokenIn
    const outputIsWETH9 = tokenOut === weth9.address

    const value = inputIsWETH ? amountIn : 0

    const params = {
      tokenIn,
      tokenOut,
      fee: FeeAmount.MEDIUM,
      sqrtPriceLimitX96:
        sqrtPriceLimitX96 ?? tokenIn.toLowerCase() < tokenOut.toLowerCase()
          ? BigNumber.from('4295128740')
          : BigNumber.from('1461446703485210103287273052203988822378723970341'),
      recipient: outputIsWETH9 ? constants.AddressZero : trader.address,
      deadline: 1,
      amountIn,
      amountOutMinimum,
    }

    const data = [router.interface.encodeFunctionData('exactInputSingle', [params])]
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, trader.address]))

    // optimized for the gas test
    return data.length === 1
      ? (router as any).connect(trader).exactInputSingle(params, { value })
      : (router as any).connect(trader).multicall(data, { value })
  }

  async function exactOutput(tokens: string[]): Promise<ContractTransaction> {
    const amountInMaximum = 10 // we don't care
    const amountOut = 1

    const inputIsWETH9 = tokens[0] === weth9.address
    const outputIsWETH9 = tokens[tokens.length - 1] === weth9.address

    const value = inputIsWETH9 ? amountInMaximum : 0

    const params = {
      path: encodePath(tokens.slice().reverse(), new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
      recipient: outputIsWETH9 ? constants.AddressZero : trader.address,
      deadline: 1,
      amountOut,
      amountInMaximum,
    }

    const data = [router.interface.encodeFunctionData('exactOutput', [params])]
    if (inputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, trader.address]))
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, trader.address]))

    return (router as any).connect(trader).multicall(data, { value })
  }

  async function exactOutputSingle(
    tokenIn: string,
    tokenOut: string,
    amountOut: number = 1,
    amountInMaximum: number = 3,
    sqrtPriceLimitX96?: BigNumber
  ): Promise<ContractTransaction> {
    const inputIsWETH9 = tokenIn === weth9.address
    const outputIsWETH9 = tokenOut === weth9.address

    const value = inputIsWETH9 ? amountInMaximum : 0

    const params = {
      tokenIn,
      tokenOut,
      fee: FeeAmount.MEDIUM,
      recipient: outputIsWETH9 ? constants.AddressZero : trader.address,
      deadline: 1,
      amountOut,
      amountInMaximum,
      sqrtPriceLimitX96:
        sqrtPriceLimitX96 ?? tokenIn.toLowerCase() < tokenOut.toLowerCase()
          ? BigNumber.from('4295128740')
          : BigNumber.from('1461446703485210103287273052203988822378723970341'),
    }

    const data = [router.interface.encodeFunctionData('exactOutputSingle', [params])]
    if (inputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, trader.address]))
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, trader.address]))

    return (router as any).connect(trader).multicall(data, { value })
  }

  // TODO should really throw this in the fixture
  beforeEach('intialize feeGrowthGlobals', async () => {
    await (await exactInput([tokens[0].address, tokens[1].address], 1, 0)).wait()
    await (await exactInput([tokens[1].address, tokens[0].address], 1, 0)).wait()
    await (await exactInput([tokens[1].address, tokens[2].address], 1, 0)).wait()
    await (await exactInput([tokens[2].address, tokens[1].address], 1, 0)).wait()
    await (await exactInput([tokens[0].address, weth9.address], 1, 0)).wait()
    await (await exactInput([weth9.address, tokens[0].address], 1, 0)).wait()
  })

  beforeEach('ensure feeGrowthGlobals are >0', async () => {
    const slots = await Promise.all(
      pools.map((pool) =>
        Promise.all([
          pool.feeGrowthGlobal0X128().then((f) => f.toString()),
          pool.feeGrowthGlobal1X128().then((f) => f.toString()),
        ])
      )
    )

    expect(slots).to.deep.eq([
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
    ])
  })

  beforeEach('ensure ticks are 0 before', async () => {
    const slots = await Promise.all(pools.map((pool) => pool.slot0().then(({ tick }) => tick)))
    expect(slots).to.deep.eq([0, 0, 0])
  })

  afterEach('ensure ticks are 0 after', async () => {
    const slots = await Promise.all(pools.map((pool) => pool.slot0().then(({ tick }) => tick)))
    expect(slots).to.deep.eq([0, 0, 0])
  })

  describe('#exactInput', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactInput(tokens.slice(0, 2).map((token) => token.address)))
    })

    it('0 -> 1 minimal', async () => {
      const callee = await deployContract(wallet, 'TestUniswapV3Callee')

      await (await (tokens[0] as any).connect(trader).approve(callee.address, constants.MaxUint256)).wait()
      await snapshotGasCost(
        (callee as any).connect(trader).swapExact0For1(pools[0].address, 2, trader.address, '4295128740')
      )
    })

    it('0 -> 1 -> 2', async () => {
      await snapshotGasCost(
        exactInput(
          tokens.map((token) => token.address),
          3
        )
      )
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(
        exactInput(
          [weth9.address, tokens[0].address],
          weth9.address.toLowerCase() < tokens[0].address.toLowerCase() ? 2 : 3
        )
      )
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(
        exactInput(
          [tokens[0].address, weth9.address],
          tokens[0].address.toLowerCase() < weth9.address.toLowerCase() ? 2 : 3
        )
      )
    })
  })

  describe('#exactInputSingle', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactInputSingle(tokens[0].address, tokens[1].address))
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(
        exactInputSingle(
          weth9.address,
          tokens[0].address,
          weth9.address.toLowerCase() < tokens[0].address.toLowerCase() ? 2 : 3
        )
      )
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(
        exactInputSingle(
          tokens[0].address,
          weth9.address,
          tokens[0].address.toLowerCase() < weth9.address.toLowerCase() ? 2 : 3
        )
      )
    })
  })

  describe('#exactOutput', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactOutput(tokens.slice(0, 2).map((token) => token.address)))
    })

    it('0 -> 1 -> 2', async () => {
      await snapshotGasCost(exactOutput(tokens.map((token) => token.address)))
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(exactOutput([weth9.address, tokens[0].address]))
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(exactOutput([tokens[0].address, weth9.address]))
    })
  })

  describe('#exactOutputSingle', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactOutputSingle(tokens[0].address, tokens[1].address))
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(exactOutputSingle(weth9.address, tokens[0].address))
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(exactOutputSingle(tokens[0].address, weth9.address))
    })
  })
})
