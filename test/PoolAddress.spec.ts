import { constants } from 'ethers'
import { Wallet } from 'zksync-web3'

import { PoolAddressTest } from '../typechain'
import { POOL_BYTECODE_HASH } from './shared/computePoolAddress'
import { expect } from './shared/expect'
import snapshotGasCost from './shared/snapshotGasCost'

import { deployContract, getWallets } from './shared/zkSyncUtils'

describe('PoolAddress', () => {
  let poolAddress: PoolAddressTest

  async function poolAddressTestFixture([wallet]: Wallet[]) {
    return (await deployContract(wallet, 'PoolAddressTest')) as PoolAddressTest
  }

  beforeEach('deploy PoolAddressTest', async () => {
    poolAddress = await poolAddressTestFixture(getWallets())
  })

  describe('#POOL_INIT_CODE_HASH', () => {
    it('equals the hash of the pool bytecode', async () => {
      expect(await poolAddress.POOL_INIT_CODE_HASH()).to.eq(POOL_BYTECODE_HASH)
    })
  })

  describe('#computeAddress', () => {
    it('all arguments equal zero', async () => {
      await expect(poolAddress.computeAddress(constants.AddressZero, constants.AddressZero, constants.AddressZero, 0))
        .to.be.reverted
    })

    it('matches example from core repo', async () => {
      expect(
        await poolAddress.computeAddress(
          '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          '0x1000000000000000000000000000000000000000',
          '0x2000000000000000000000000000000000000000',
          250
        )
      ).to.matchSnapshot()
    })

    it('token argument order cannot be in reverse', async () => {
      await expect(
        poolAddress.computeAddress(
          '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          '0x2000000000000000000000000000000000000000',
          '0x1000000000000000000000000000000000000000',
          3000
        )
      ).to.be.reverted
    })

    it('gas cost', async () => {
      await snapshotGasCost(
        poolAddress.getGasCostOfComputeAddress(
          '0x5FbDB2315678afecb367f032d93F642f64180aa3',
          '0x1000000000000000000000000000000000000000',
          '0x2000000000000000000000000000000000000000',
          3000
        )
      )
    })
  })
})
