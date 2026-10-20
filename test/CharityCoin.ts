import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { network } from "hardhat";

describe("CharityCoin — local prototype", function () {
  async function deployFixture() {
    const { ethers } = await network.connect();
    const [administrator, issuer, donor, other] = await ethers.getSigners();

    const factory = await ethers.getContractFactory(
      "CharityCoin",
      administrator
    );
    const coin = await factory.deploy(issuer.address);
    await coin.waitForDeployment();

    return { ethers, administrator, issuer, donor, other, coin };
  }

  it("issues 900 CHC for a simulated 1,000 RMB deposit", async function () {
    const { ethers, issuer, donor, coin } = await deployFixture();
    const depositId = ethers.id("simulated-bank-deposit-001");

    await (
      await coin.connect(issuer).issue(depositId, donor.address, 100_000n)
    ).wait();

    assert.equal(await coin.balanceOf(donor.address), ethers.parseEther("900"));
    assert.equal(await coin.totalSupply(), ethers.parseEther("900"));
    assert.equal(await coin.totalConfirmedCents(), 100_000n);
    assert.equal(await coin.totalFeeCents(), 10_000n);
    assert.equal(await coin.processedDeposit(depositId), true);
  });

  it("rejects issuing twice against the same deposit ID", async function () {
    const { ethers, issuer, donor, coin } = await deployFixture();
    const depositId = ethers.id("simulated-bank-deposit-002");

    await (
      await coin.connect(issuer).issue(depositId, donor.address, 100_000n)
    ).wait();

    await assert.rejects(
      coin.connect(issuer).issue(depositId, donor.address, 100_000n),
      /Deposit already issued/
    );
    assert.equal(await coin.totalSupply(), ethers.parseEther("900"));
  });

  it("rejects issuance by anyone other than the bank issuer", async function () {
    const { ethers, donor, coin } = await deployFixture();

    await assert.rejects(
      coin
        .connect(donor)
        .issue(ethers.id("unauthorized-deposit"), donor.address, 100_000n),
      /Not bank issuer/
    );
    assert.equal(await coin.totalSupply(), 0n);
  });

  it("rejects direct wallet-to-wallet transfers", async function () {
    const { ethers, issuer, donor, other, coin } = await deployFixture();

    await (
      await coin
        .connect(issuer)
        .issue(ethers.id("simulated-bank-deposit-003"), donor.address, 100_000n)
    ).wait();

    await assert.rejects(
      coin.connect(donor).transfer(other.address, ethers.parseEther("1")),
      /Wallet transfers disabled/
    );
    assert.equal(await coin.balanceOf(other.address), 0n);
  });

  it("rejects granting an allowance to an ordinary wallet", async function () {
    const { donor, other, coin } = await deployFixture();

    await assert.rejects(
      coin.connect(donor).approve(other.address, 1n),
      /Spender not system contract/
    );
  });

  it("rejects deposit amounts whose 10% fee would require rounding", async function () {
    const { ethers, issuer, donor, coin } = await deployFixture();

    await assert.rejects(
      coin
        .connect(issuer)
        .issue(ethers.id("invalid-cents"), donor.address, 101n),
      /Invalid cents/
    );
    assert.equal(await coin.totalSupply(), 0n);
  });
});