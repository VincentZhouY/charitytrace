  it("三名预先登记的验证者投票后，项目可由任何人结算为通过", async function () {
    const { ethers } = await network.connect();
    const [creator, a, b, c, caller] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();

    for (const verifier of [a, b, c]) {
      await (await vault.connect(verifier).registerVerifier({ value: stake })).wait();
    }
    await (await vault.connect(creator).createProject(ethers.id("项目 A"))).wait();

    for (const verifier of [a, b, c]) {
      await (await vault.connect(verifier).voteOnProject(1n, true)).wait();
    }

    expect((await vault.reviews(1n)).approvals).to.equal(3n);
    expect((await vault.reviews(1n)).status).to.equal(0n);

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.connect(caller).finalizeReview(1n)).wait();

    expect((await vault.reviews(1n)).status).to.equal(1n);
  });

  it("阻止项目创建者投票、重复投票及项目创建后才登记的人投票", async function () {
    const { ethers } = await network.connect();
    const [creator, early, late] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();

    await (await vault.connect(early).registerVerifier({ value: stake })).wait();
    await (await vault.connect(creator).registerVerifier({ value: stake })).wait();
    await (await vault.connect(creator).createProject(ethers.id("项目 A"))).wait();
    await (await vault.connect(late).registerVerifier({ value: stake })).wait();

    await assert.rejects(
      async () => vault.connect(creator).voteOnProject(1n, true),
      /Creator cannot vote/
    );
    await assert.rejects(
      async () => vault.connect(late).voteOnProject(1n, true),
      /Register before project creation/
    );

    await (await vault.connect(early).voteOnProject(1n, true)).wait();
    await assert.rejects(
      async () => vault.connect(early).voteOnProject(1n, false),
      /Already voted/
    );
  });

  it("不足三票的项目过期，且不能提前结算或重复结算", async function () {
    const { ethers } = await network.connect();
    const vault = await ethers.deployContract("CharityVault");

    await (await vault.createProject(ethers.id("项目 A"))).wait();
    await assert.rejects(
      async () => vault.finalizeReview(1n),
      /Voting period still open/
    );

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.finalizeReview(1n)).wait();

    expect((await vault.reviews(1n)).status).to.equal(3n);
    await assert.rejects(
      async () => vault.finalizeReview(1n),
      /Review closed/
    );
  });

  it("验证者退出只退保证金，不减少项目捐款", async function () {
    const { ethers } = await network.connect();
    const [donor, verifier] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");
    const stake = await vault.VERIFIER_STAKE();
    const donation = ethers.parseEther("1");

    await (await vault.createProject(ethers.id("项目 A"))).wait();
    await (await vault.connect(donor).donateToProject(1n, { value: donation })).wait();
    await (await vault.connect(verifier).registerVerifier({ value: stake })).wait();

    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(donation + stake);

    await (await vault.connect(verifier).exitVerifier()).wait();

    expect(await vault.projectBalances(1n)).to.equal(donation);
    expect(await vault.totalVerifierStakes()).to.equal(0n);
    expect(await ethers.provider.getBalance(await vault.getAddress()))
      .to.equal(donation);
  });
import { expect } from "chai";
import { strict as assert } from "node:assert";
import { network } from "hardhat";

describe("CharityVault", function () {
  it("记录捐款人和捐款总额", async function () {
    const { ethers } = await network.connect();
    const [donor] = await ethers.getSigners();

    const vault = await ethers.deployContract("CharityVault");
    await vault.waitForDeployment();

    const amount = ethers.parseEther("1");
    const tx = await vault.connect(donor).donate({ value: amount });
    await tx.wait();

    expect(await vault.donations(donor.address)).to.equal(amount);
    expect(await vault.totalDonations()).to.equal(amount);
    expect(await vault.unallocatedDonations()).to.equal(amount);
  });

  it("将捐款实际存入合约", async function () {
    const { ethers } = await network.connect();
    const vault = await ethers.deployContract("CharityVault");
    await vault.waitForDeployment();

    const amount = ethers.parseEther("1");
    await (await vault.donate({ value: amount })).wait();

    expect(
      await ethers.provider.getBalance(await vault.getAddress())
    ).to.equal(amount);
    expect(await vault.totalDonations()).to.equal(amount);
  });

  it("拒绝零金额捐款", async function () {
    const { ethers } = await network.connect();
    const vault = await ethers.deployContract("CharityVault");

    await assert.rejects(
      async () => vault.donate({ value: 0n }),
      /Donation must be greater than zero/
    );

    expect(await vault.totalDonations()).to.equal(0n);
  });

  it("累加不同捐款人的金额", async function () {
    const { ethers } = await network.connect();
    const [alice, bob] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");

    const aliceAmount = ethers.parseEther("1");
    const bobAmount = ethers.parseEther("0.5");

    await (await vault.connect(alice).donate({ value: aliceAmount })).wait();
    await (await vault.connect(bob).donate({ value: bobAmount })).wait();

    expect(await vault.donations(alice.address)).to.equal(aliceAmount);
    expect(await vault.donations(bob.address)).to.equal(bobAmount);
    expect(await vault.totalDonations()).to.equal(aliceAmount + bobAmount);
  });

  it("允许任何人登记项目，但不因此赋予提款权", async function () {
    const { ethers } = await network.connect();
    const [alice] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");

    const hash = ethers.id("公开项目说明 A");
    await (await vault.connect(alice).createProject(hash)).wait();

    expect(await vault.projectCount()).to.equal(1n);

    const project = await vault.projects(1n);
    expect(project.creator).to.equal(alice.address);
    expect(project.metadataHash).to.equal(hash);
    expect(await vault.projectBalances(1n)).to.equal(0n);
  });

  it("不同项目的捐款余额互不混淆", async function () {
    const { ethers } = await network.connect();
    const [alice, bob] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");

    await (await vault.createProject(ethers.id("项目 A"))).wait();
    await (await vault.createProject(ethers.id("项目 B"))).wait();

    const amountA = ethers.parseEther("1");
    const amountB = ethers.parseEther("0.5");

    await (
      await vault.connect(alice).donateToProject(1n, { value: amountA })
    ).wait();
    await (
      await vault.connect(bob).donateToProject(2n, { value: amountB })
    ).wait();

    expect(await vault.projectBalances(1n)).to.equal(amountA);
    expect(await vault.projectBalances(2n)).to.equal(amountB);
    expect(await vault.projectDonations(1n, alice.address)).to.equal(amountA);
    expect(await vault.projectDonations(2n, bob.address)).to.equal(amountB);
    expect(await vault.projectDonations(1n, bob.address)).to.equal(0n);
  });

  it("同一人对同一项目多次捐款会累加", async function () {
    const { ethers } = await network.connect();
    const [alice] = await ethers.getSigners();
    const vault = await ethers.deployContract("CharityVault");

    await (await vault.createProject(ethers.id("项目 A"))).wait();

    const first = ethers.parseEther("1");
    const second = ethers.parseEther("0.25");

    await (
      await vault.connect(alice).donateToProject(1n, { value: first })
    ).wait();
    await (
      await vault.connect(alice).donateToProject(1n, { value: second })
    ).wait();

    expect(await vault.projectDonations(1n, alice.address)).to.equal(
      first + second
    );
    expect(await vault.projectBalances(1n)).to.equal(first + second);
    expect(await vault.donations(alice.address)).to.equal(first + second);
  });

  it("拒绝无效项目和零金额项目捐款", async function () {
    const { ethers } = await network.connect();
    const vault = await ethers.deployContract("CharityVault");

    await (await vault.createProject(ethers.id("项目 A"))).wait();

    await assert.rejects(
      async () => vault.donateToProject(0n, { value: 1n }),
      /Invalid project/
    );
    await assert.rejects(
      async () => vault.donateToProject(2n, { value: 1n }),
      /Invalid project/
    );
    await assert.rejects(
      async () => vault.donateToProject(1n, { value: 0n }),
      /Donation must be greater than zero/
    );

    expect(await vault.totalDonations()).to.equal(0n);
  });

  it("未指定项目捐款与各项目余额合计等于合约收到的资金", async function () {
    const { ethers } = await network.connect();
    const vault = await ethers.deployContract("CharityVault");

    await (await vault.createProject(ethers.id("项目 A"))).wait();
    await (await vault.createProject(ethers.id("项目 B"))).wait();

    const unallocated = ethers.parseEther("0.2");
    const projectA = ethers.parseEther("1");
    const projectB = ethers.parseEther("0.5");

    await (await vault.donate({ value: unallocated })).wait();
    await (
      await vault.donateToProject(1n, { value: projectA })
    ).wait();
    await (
      await vault.donateToProject(2n, { value: projectB })
    ).wait();

    const accountedFor =
      (await vault.unallocatedDonations()) +
      (await vault.projectBalances(1n)) +
      (await vault.projectBalances(2n));

    expect(accountedFor).to.equal(await vault.totalDonations());
    expect(
      await ethers.provider.getBalance(await vault.getAddress())
    ).to.equal(accountedFor);
  });
});
