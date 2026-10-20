import { expect } from "chai";
import { strict as assert } from "node:assert";
import { network } from "hardhat";

describe("CharityVault 核验边界", function () {
  it("三票中两票赞成，恰好达到三分之二时通过", async function () {
    const { ethers } = await network.connect();
    const [creator, a, b, c] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();

    for (const verifier of [a, b, c]) {
      await (await vault.connect(verifier).registerVerifier({ value: stake })).wait();
    }
    await (await vault.connect(creator).createProject(ethers.id("边界项目 A"))).wait();

    await (await vault.connect(a).voteOnProject(1n, true)).wait();
    await (await vault.connect(b).voteOnProject(1n, true)).wait();
    await (await vault.connect(c).voteOnProject(1n, false)).wait();

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.finalizeReview(1n)).wait();

    const review = await vault.reviews(1n);
    expect(review.approvals).to.equal(2n);
    expect(review.rejections).to.equal(1n);
    expect(review.status).to.equal(1n);
  });

  it("三票中仅一票赞成时拒绝", async function () {
    const { ethers } = await network.connect();
    const [creator, a, b, c] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();

    for (const verifier of [a, b, c]) {
      await (await vault.connect(verifier).registerVerifier({ value: stake })).wait();
    }
    await (await vault.connect(creator).createProject(ethers.id("边界项目 B"))).wait();

    await (await vault.connect(a).voteOnProject(1n, true)).wait();
    await (await vault.connect(b).voteOnProject(1n, false)).wait();
    await (await vault.connect(c).voteOnProject(1n, false)).wait();

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.finalizeReview(1n)).wait();

    const review = await vault.reviews(1n);
    expect(review.approvals).to.equal(1n);
    expect(review.rejections).to.equal(2n);
    expect(review.status).to.equal(2n);
  });

  it("已投票者不能提前退保证金，到期后退款不动用捐款", async function () {
    const { ethers } = await network.connect();
    const [creator, verifier, donor] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();
    const donation = ethers.parseEther("1");

    await (await vault.connect(verifier).registerVerifier({ value: stake })).wait();
    await (await vault.connect(creator).createProject(ethers.id("边界项目 C"))).wait();
    await (await vault.connect(verifier).voteOnProject(1n, true)).wait();
    await (
      await vault.connect(donor).donateToProject(1n, { value: donation })
    ).wait();

    await assert.rejects(
      async () => vault.connect(verifier).exitVerifier(),
      /Vote still open/
    );

    expect(await vault.totalVerifierStakes()).to.equal(stake);
    expect(await vault.projectBalances(1n)).to.equal(donation);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(donation + stake);

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.connect(verifier).exitVerifier()).wait();

    expect(await vault.totalVerifierStakes()).to.equal(0n);
    expect(await vault.projectBalances(1n)).to.equal(donation);
    expect(await vault.totalDonations()).to.equal(donation);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(donation);
  });
});
