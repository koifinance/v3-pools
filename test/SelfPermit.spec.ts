import { constants } from 'ethers'
import { Wallet } from 'zksync-web3'

import { SelfPermitTest, TestERC20PermitAllowed } from '../typechain'
import { expect } from 'chai'
import { getPermitSignature } from './shared/permit'

import { deployContract, getWallets } from './shared/zkSyncUtils'

describe('SelfPermit', () => {
  let wallet: Wallet
  let other: Wallet

  async function fixture([wallet]: Wallet[]): Promise<{
    token: TestERC20PermitAllowed
    selfPermitTest: SelfPermitTest
  }> {
    const token = (await deployContract(wallet, 'TestERC20PermitAllowed', [0])) as TestERC20PermitAllowed

    const selfPermitTest = (await deployContract(wallet, 'SelfPermitTest')) as SelfPermitTest

    return {
      token,
      selfPermitTest,
    }
  }

  let token: TestERC20PermitAllowed
  let selfPermitTest: SelfPermitTest

  before('create fixture loader', async () => {
    const wallets = getWallets()
    ;[wallet, other] = wallets
  })

  beforeEach('load fixture', async () => {
    ;({ token, selfPermitTest } = await fixture([wallet]))
  })

  it('#permit', async () => {
    const value = 123

    const { v, r, s } = await getPermitSignature(wallet, token, other.address, value)

    expect(await token.allowance(wallet.address, other.address)).to.be.eq(0)
    await (
      await token['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'](
        wallet.address,
        other.address,
        value,
        constants.MaxUint256,
        v,
        r,
        s
      )
    ).wait()
    expect(await token.allowance(wallet.address, other.address)).to.be.eq(value)
  })

  describe('#selfPermit', () => {
    const value = 456

    it('works', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, value)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(0)
      await (await selfPermitTest.selfPermit(token.address, value, constants.MaxUint256, v, r, s)).wait()
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(value)
    })

    it('fails if permit is submitted externally', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, value)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(0)
      await (
        await token['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'](
          wallet.address,
          selfPermitTest.address,
          value,
          constants.MaxUint256,
          v,
          r,
          s
        )
      ).wait()
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(value)

      await expect(selfPermitTest.selfPermit(token.address, value, constants.MaxUint256, v, r, s)).to.be.revertedWith(
        'ERC20Permit: invalid signature'
      )
    })
  })

  describe('#selfPermitIfNecessary', () => {
    const value = 789

    it('works', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, value)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(0)
      await (await selfPermitTest.selfPermitIfNecessary(token.address, value, constants.MaxUint256, v, r, s)).wait()
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(value)
    })

    it('does not fail if permit is submitted externally', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, value)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(0)
      await (
        await token['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'](
          wallet.address,
          selfPermitTest.address,
          value,
          constants.MaxUint256,
          v,
          r,
          s
        )
      ).wait()
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(value)

      await (await selfPermitTest.selfPermitIfNecessary(token.address, value, constants.MaxUint256, v, r, s)).wait()
    })
  })

  describe('#selfPermitAllowed', () => {
    it('works', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, constants.MaxUint256)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(0)
      await expect(selfPermitTest.selfPermitAllowed(token.address, 0, constants.MaxUint256, v, r, s))
        .to.emit(token, 'Approval')
        .withArgs(wallet.address, selfPermitTest.address, constants.MaxUint256)
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(constants.MaxUint256)
    })

    it('fails if permit is submitted externally', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, constants.MaxUint256)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(0)
      await (
        await token['permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)'](
          wallet.address,
          selfPermitTest.address,
          0,
          constants.MaxUint256,
          true,
          v,
          r,
          s
        )
      ).wait()
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(constants.MaxUint256)

      await expect(
        selfPermitTest.selfPermitAllowed(token.address, 0, constants.MaxUint256, v, r, s)
      ).to.be.revertedWith('TestERC20PermitAllowed::permit: wrong nonce')
    })
  })

  describe('#selfPermitAllowedIfNecessary', () => {
    it('works', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, constants.MaxUint256)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.eq(0)
      await expect(selfPermitTest.selfPermitAllowedIfNecessary(token.address, 0, constants.MaxUint256, v, r, s))
        .to.emit(token, 'Approval')
        .withArgs(wallet.address, selfPermitTest.address, constants.MaxUint256)
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.eq(constants.MaxUint256)
    })

    it('skips if already max approved', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, constants.MaxUint256)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(0)
      await (await token.approve(selfPermitTest.address, constants.MaxUint256)).wait()
      await expect(
        selfPermitTest.selfPermitAllowedIfNecessary(token.address, 0, constants.MaxUint256, v, r, s)
      ).to.not.emit(token, 'Approval')
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.eq(constants.MaxUint256)
    })

    it('does not fail if permit is submitted externally', async () => {
      const { v, r, s } = await getPermitSignature(wallet, token, selfPermitTest.address, constants.MaxUint256)

      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(0)
      await (
        await token['permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)'](
          wallet.address,
          selfPermitTest.address,
          0,
          constants.MaxUint256,
          true,
          v,
          r,
          s
        )
      ).wait()
      expect(await token.allowance(wallet.address, selfPermitTest.address)).to.be.eq(constants.MaxUint256)

      await (await selfPermitTest.selfPermitAllowedIfNecessary(token.address, 0, constants.MaxUint256, v, r, s)).wait()
    })
  })
})
