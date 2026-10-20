import { expect } from "chai";
import { strict as assert } from "node:assert";
import { network } from "hardhat";

describe("CharityVault unallocated donation refunds", function () {
  it("refunds only the caller's donations and blocks a second refund", async function () {
    const { ethers } = await network.connect();
    const [alice, bob, outsider] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const first = ethers.parseEther("0.4");
    const second = ethers.parseEther("0.6");
    const bobAmount = ethers.parseEther("0.5");

    await (await vault.connect(alice).donate({ value: first })).wait();
    await (await vault.connect(alice).donate({ value: second })).wait();
    await (await vault.connect(bob).donate({ value: bobAmount })).wait();

    expect(await vault.unallocatedByDonor(alice.address)).to.equal(first + second);
    await assert.rejects(
      async () => vault.connect(outsider).refundUnallocatedDonation(),
      /No unallocated donation to refund/
    );

    await expect(vault.connect(alice).refundUnallocatedDonation())
      .to.emit(vault, "UnallocatedDonationRefunded")
      .withArgs(alice.address, first + second);

    expect(await vault.unallocatedByDonor(alice.address)).to.equal(0n);
    expect(await vault.donations(alice.address)).to.equal(0n);
    expect(await vault.unallocatedByDonor(bob.address)).to.equal(bobAmount);
    expect(await vault.unallocatedDonations()).to.equal(bobAmount);
    expect(await vault.totalDonations()).to.equal(bobAmount);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(bobAmount);

    await assert.rejects(
      async () => vault.connect(alice).refundUnallocatedDonation(),
      /No unallocated donation to refund/
    );
  });

  it("keeps project donations and verifier stakes separate", async function () {
    const { ethers } = await network.connect();
    const [alice, bob, verifier] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const unallocated = ethers.parseEther("0.2");
    const projectAmount = ethers.parseEther("1");
    const bobAmount = ethers.parseEther("0.3");
    const stake = await vault.VERIFIER_STAKE();

    await (await vault.createProject(ethers.id("project A"))).wait();
    await (await vault.connect(alice).donate({ value: unallocated })).wait();
    await (await vault.connect(alice).donateToProject(1n, { value: projectAmount })).wait();
    await (await vault.connect(bob).donate({ value: bobAmount })).wait();
    await (await vault.connect(verifier).registerVerifier({ value: stake })).wait();

    await (await vault.connect(alice).refundUnallocatedDonation()).wait();

    expect(await vault.donations(alice.address)).to.equal(projectAmount);
    expect(await vault.projectDonations(1n, alice.address)).to.equal(projectAmount);
    expect(await vault.projectBalances(1n)).to.equal(projectAmount);
    expect(await vault.unallocatedDonations()).to.equal(bobAmount);
    expect(await vault.totalDonations()).to.equal(projectAmount + bobAmount);
    expect(await vault.totalVerifierStakes()).to.equal(stake);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(projectAmount + bobAmount + stake);
  });

  it("can refund a later new donation after an earlier refund", async function () {
    const { ethers } = await network.connect();
    const [alice] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const first = ethers.parseEther("0.2");
    const second = ethers.parseEther("0.3");

    await (await vault.connect(alice).donate({ value: first })).wait();
    await (await vault.connect(alice).refundUnallocatedDonation()).wait();
    await (await vault.connect(alice).donate({ value: second })).wait();
    expect(await vault.unallocatedByDonor(alice.address)).to.equal(second);

    await (await vault.connect(alice).refundUnallocatedDonation()).wait();
    expect(await vault.unallocatedByDonor(alice.address)).to.equal(0n);
    expect(await vault.totalDonations()).to.equal(0n);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(0n);
  });
});