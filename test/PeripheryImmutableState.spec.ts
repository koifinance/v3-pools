import { Wallet, Contract } from 'zksync-web3'

import { PeripheryImmutableStateTest, IWETH9 } from '../typechain'
import { expect } from './shared/expect'
import { v3RouterFixture } from './shared/externalFixtures'

import { deployContract, getWallets } from './shared/zkSyncUtils'

describe('PeripheryImmutableState', () => {
  async function nonfungiblePositionManagerFixture([wallet]: Wallet[]): Promise<{
    weth9: IWETH9
    factory: Contract
    state: PeripheryImmutableStateTest
  }> {
    const { weth9, factory } = await v3RouterFixture([wallet])

    const state = (await deployContract(wallet, 'PeripheryImmutableStateTest', [
      factory.address,
      weth9.address,
    ])) as PeripheryImmutableStateTest

    return {
      weth9,
      factory: factory as Contract,
      state,
    }
  }

  let factory: Contract
  let weth9: IWETH9
  let state: PeripheryImmutableStateTest

  beforeEach('load fixture', async () => {
    ;({ state, weth9, factory } = await nonfungiblePositionManagerFixture(getWallets()))
  })

  it('bytecode size', async () => {
    expect(((await state.provider.getCode(state.address)).length - 2) / 2).to.matchSnapshot()
  })

  describe('#WETH9', () => {
    it('points to WETH9', async () => {
      expect(await state.WETH9()).to.eq(weth9.address)
    })
  })

  describe('#factory', () => {
    it('points to v3 core factory', async () => {
      expect(await state.factory()).to.eq(factory.address)
    })
  })
})
