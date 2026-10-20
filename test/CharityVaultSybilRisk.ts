import { expect } from "chai";
import { network } from "hardhat";

describe("CharityVault 抗女巫风险", function () {
  it("三个地址即可让项目通过，但不能证明是三个独立的人", async function () {
    const { ethers } = await network.connect();
    const [creator, addressA, addressB, addressC, donor] =
      await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();
    const donation = ethers.parseEther("1");

    // 合约无法判断这三个地址是否由同一人控制。
    for (const signer of [addressA, addressB, addressC]) {
      await (
        await vault.connect(signer).registerVerifier({ value: stake })
      ).wait();
    }

    await (
      await vault.connect(creator).createProject(ethers.id("待核验项目"))
    ).wait();
    await (
      await vault.connect(donor).donateToProject(1n, { value: donation })
    ).wait();

    for (const signer of [addressA, addressB, addressC]) {
      await (await vault.connect(signer).voteOnProject(1n, true)).wait();
    }

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.finalizeReview(1n)).wait();

    expect((await vault.reviews(1n)).status).to.equal(1n);
    expect(await vault.projectBalances(1n)).to.equal(donation);
    expect(await vault.totalVerifierStakes()).to.equal(stake * 3n);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(donation + stake * 3n);
  });
});
