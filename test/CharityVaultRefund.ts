import { expect } from "chai";
import { strict as assert } from "node:assert";
import { network } from "hardhat";

describe("CharityVault 项目捐款退款", function () {
  it("过期项目仅退原捐款人；重复领取失败；其他资金不受影响", async function () {
    const { ethers } = await network.connect();
    const [creator, alice, bob, outsider] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const aliceAmount = ethers.parseEther("1");
    const bobAmount = ethers.parseEther("2");
    const unallocated = ethers.parseEther("0.5");

    await (await vault.connect(creator).createProject(ethers.id("项目一"))).wait();
    await (await vault.connect(creator).createProject(ethers.id("项目二"))).wait();
    await (await vault.connect(alice).donateToProject(1n, { value: aliceAmount })).wait();
    await (await vault.connect(bob).donateToProject(1n, { value: bobAmount })).wait();
    await (await vault.connect(alice).donateToProject(2n, { value: bobAmount })).wait();
    await (await vault.connect(bob).donate({ value: unallocated })).wait();

    await assert.rejects(
      async () => vault.connect(alice).refundProjectDonation(1n),
      /Project not refundable/
    );
    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await assert.rejects(
      async () => vault.connect(alice).refundProjectDonation(1n),
      /Project not refundable/
    );

    await (await vault.connect(outsider).finalizeReview(1n)).wait();
    expect((await vault.reviews(1n)).status).to.equal(3n);
    await assert.rejects(
      async () => vault.connect(outsider).refundProjectDonation(1n),
      /No donation to refund/
    );

    await (await vault.connect(alice).refundProjectDonation(1n)).wait();
    expect(await vault.projectDonations(1n, alice.address)).to.equal(0n);
    expect(await vault.projectDonations(1n, bob.address)).to.equal(bobAmount);
    expect(await vault.projectBalances(1n)).to.equal(bobAmount);
    expect(await vault.projectBalances(2n)).to.equal(bobAmount);
    expect(await vault.unallocatedDonations()).to.equal(unallocated);
    expect(await vault.donations(alice.address)).to.equal(bobAmount);
    expect(await vault.totalDonations()).to.equal(bobAmount * 2n + unallocated);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(bobAmount * 2n + unallocated);

    await assert.rejects(
      async () => vault.connect(alice).refundProjectDonation(1n),
      /No donation to refund/
    );
    await (await vault.connect(bob).refundProjectDonation(1n)).wait();
    expect(await vault.projectBalances(1n)).to.equal(0n);
  });

  it("被拒绝项目可退款，验证者保证金保持隔离", async function () {
    const { ethers } = await network.connect();
    const [creator, a, b, c, donor] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();
    const donation = ethers.parseEther("1");

    for (const verifier of [a, b, c]) {
      await (await vault.connect(verifier).registerVerifier({ value: stake })).wait();
    }
    await (await vault.connect(creator).createProject(ethers.id("拒绝项目"))).wait();
    await (await vault.connect(donor).donateToProject(1n, { value: donation })).wait();
    for (const verifier of [a, b, c]) {
      await (await vault.connect(verifier).voteOnProject(1n, false)).wait();
    }

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.finalizeReview(1n)).wait();
    expect((await vault.reviews(1n)).status).to.equal(2n);

    await (await vault.connect(donor).refundProjectDonation(1n)).wait();
    expect(await vault.totalDonations()).to.equal(0n);
    expect(await vault.projectBalances(1n)).to.equal(0n);
    expect(await vault.totalVerifierStakes()).to.equal(stake * 3n);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(stake * 3n);
  });

  it("达到 Approved 的项目不能使用本退款入口", async function () {
    const { ethers } = await network.connect();
    const [creator, a, b, c, donor] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();
    const donation = ethers.parseEther("1");

    for (const verifier of [a, b, c]) {
      await (await vault.connect(verifier).registerVerifier({ value: stake })).wait();
    }
    await (await vault.connect(creator).createProject(ethers.id("通过项目"))).wait();
    await (await vault.connect(donor).donateToProject(1n, { value: donation })).wait();
    for (const verifier of [a, b, c]) {
      await (await vault.connect(verifier).voteOnProject(1n, true)).wait();
    }

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.finalizeReview(1n)).wait();
    expect((await vault.reviews(1n)).status).to.equal(1n);
    await assert.rejects(
      async () => vault.connect(donor).refundProjectDonation(1n),
      /Project not refundable/
    );
    expect(await vault.projectBalances(1n)).to.equal(donation);
  });
});
