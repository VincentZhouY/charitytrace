import { expect } from "chai";
import { network } from "hardhat";

describe("AidApplicationReview: local settlement prototype", function () {
  async function fixture() {
    const { ethers } = await network.connect();
    const signers = await ethers.getSigners();
    const applicant = signers[1];
    const funder = signers[2];
    const candidates = signers.slice(3, 13);
    const outsider = signers[13];
    const deposit = ethers.parseEther("1000");
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("salted-evidence"));
    const metadata = ethers.keccak256(ethers.toUtf8Bytes("salted-application"));

    const token = await (
      await ethers.getContractFactory("MockCharityToken")
    ).deploy();
    const provider = await (
      await ethers.getContractFactory("MockRandomnessProvider")
    ).deploy();
    const review = await (
      await ethers.getContractFactory("AidApplicationReview")
    ).deploy(await token.getAddress(), await provider.getAddress());

    for (const candidate of candidates) {
      await review.connect(candidate).registerCandidate();
    }

    await token.mint(applicant.address, deposit * 2n);
    await token.mint(funder.address, deposit * 2n);
    await token.connect(applicant).approve(await review.getAddress(), deposit * 2n);
    await token.connect(funder).approve(await review.getAddress(), deposit * 2n);

    return {
      ethers, applicant, funder, candidates, outsider,
      deposit, evidence, metadata, token, provider, review,
    };
  }

  async function start() {
    const f = await fixture();
    await f.review.connect(f.applicant).submit(
      f.ethers.parseEther("50000"), f.metadata
    );
    await f.review.connect(f.funder).fundAndRequest(1);
    return f;
  }

  async function endVoting(f: Awaited<ReturnType<typeof fixture>>) {
    await f.ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
    await f.ethers.provider.send("evm_mine", []);
  }

  it("rounds target upward and excludes the applicant from selection", async function () {
    const f = await fixture();
    const [deposit, count] = await f.review.quote(
      f.ethers.parseEther("50001")
    );
    expect(deposit).to.equal(f.ethers.parseEther("2000"));
    expect(count).to.equal(20n);

    await f.review.connect(f.applicant).registerCandidate();
    await f.review.connect(f.applicant).submit(
      f.ethers.parseEther("50000"), f.metadata
    );
    await f.review.connect(f.funder).fundAndRequest(1);
    await f.provider.fulfill(1, 123);
    expect(await f.review.selected(1, f.applicant.address)).to.equal(false);
    expect((await f.review.getSelectedVerifiers(1)).length).to.equal(10);
    expect(await f.review.rewardFunder(1)).to.equal(f.funder.address);
  });

  it("rejects forged callbacks, outsiders and duplicate votes", async function () {
    const f = await start();
    await expect(f.review.fulfillRandomness(1, 123))
      .to.be.revertedWith("Unauthorized provider");
    await f.provider.fulfill(1, 123);
    await expect(f.provider.fulfill(1, 123))
      .to.be.revertedWith("Request already fulfilled");
    await expect(f.review.connect(f.applicant).vote(1, true, f.evidence))
      .to.be.revertedWith("Not selected");
    await f.review.connect(f.candidates[0]).vote(1, true, f.evidence);
    await expect(f.review.connect(f.candidates[0]).vote(1, true, f.evidence))
      .to.be.revertedWith("Already voted");
    await expect(f.review.connect(f.applicant).withdraw(1))
      .to.be.revertedWith("Nothing to withdraw");
  });

  it("7/10 participating, 5 approve: voters share reward; deposit returns", async function () {
    const f = await start();
    await f.provider.fulfill(1, 111);
    for (const candidate of f.candidates.slice(0, 5)) {
      await f.review.connect(candidate).vote(1, true, f.evidence);
    }
    for (const candidate of f.candidates.slice(5, 7)) {
      await f.review.connect(candidate).vote(1, false, f.evidence);
    }
    await expect(f.review.finalizePreliminary(1))
      .to.be.revertedWith("Voting still open");
    await endVoting(f);
    await f.review.connect(f.outsider).finalizePreliminary(1);
    expect((await f.review.applications(1)).status).to.equal(4n);
    await expect(f.review.finalizePreliminary(1))
      .to.be.revertedWith("Not voting");

    const share = f.deposit / 7n;
    const remainder = f.deposit % 7n;
    expect(await f.review.claimable(1, f.applicant.address)).to.equal(f.deposit);
    expect(await f.review.claimable(1, f.funder.address)).to.equal(remainder);
    for (const candidate of f.candidates.slice(0, 7)) {
      expect(await f.review.claimable(1, candidate.address)).to.equal(share);
      await f.review.connect(candidate).withdraw(1);
    }
    expect(await f.review.claimable(1, f.candidates[7].address)).to.equal(0n);
    await expect(f.review.connect(f.candidates[7]).withdraw(1))
      .to.be.revertedWith("Nothing to withdraw");
    await f.review.connect(f.applicant).withdraw(1);
    await f.review.connect(f.funder).withdraw(1);
    expect(await f.token.balanceOf(await f.review.getAddress())).to.equal(0n);
    await expect(f.review.connect(f.applicant).withdraw(1))
      .to.be.revertedWith("Nothing to withdraw");
  });

  it("7/10 participating, 5 reject: voters share forfeited deposit", async function () {
    const f = await start();
    await f.provider.fulfill(1, 222);
    for (const candidate of f.candidates.slice(0, 5)) {
      await f.review.connect(candidate).vote(1, false, f.evidence);
    }
    for (const candidate of f.candidates.slice(5, 7)) {
      await f.review.connect(candidate).vote(1, true, f.evidence);
    }
    await endVoting(f);
    await f.review.finalizePreliminary(1);

    expect((await f.review.applications(1)).status).to.equal(5n);
    expect(await f.review.claimable(1, f.funder.address)).to.equal(f.deposit);
    expect(await f.review.claimable(1, f.applicant.address))
      .to.equal(f.deposit % 7n);
    for (const candidate of f.candidates.slice(0, 7)) {
      expect(await f.review.claimable(1, candidate.address))
        .to.equal(f.deposit / 7n);
      await f.review.connect(candidate).withdraw(1);
    }
    await f.review.connect(f.applicant).withdraw(1);
    await f.review.connect(f.funder).withdraw(1);
    expect(await f.token.balanceOf(await f.review.getAddress())).to.equal(0n);
  });

  it("7 voters split 4:3: inconclusive, both principals refunded", async function () {
    const f = await start();
    await f.provider.fulfill(1, 333);
    for (const candidate of f.candidates.slice(0, 4)) {
      await f.review.connect(candidate).vote(1, true, f.evidence);
    }
    for (const candidate of f.candidates.slice(4, 7)) {
      await f.review.connect(candidate).vote(1, false, f.evidence);
    }
    await endVoting(f);
    await f.review.finalizePreliminary(1);

    expect((await f.review.applications(1)).status).to.equal(6n);
    expect(await f.review.claimable(1, f.applicant.address)).to.equal(f.deposit);
    expect(await f.review.claimable(1, f.funder.address)).to.equal(f.deposit);
    expect(await f.review.claimable(1, f.candidates[0].address)).to.equal(0n);
    await f.review.connect(f.applicant).withdraw(1);
    await f.review.connect(f.funder).withdraw(1);
    expect(await f.token.balanceOf(await f.review.getAddress())).to.equal(0n);
  });

  it("6 votes are insufficient even if every vote rejects", async function () {
    const f = await start();
    await f.provider.fulfill(1, 789);
    for (const candidate of f.candidates.slice(0, 6)) {
      await f.review.connect(candidate).vote(1, false, f.evidence);
    }
    await endVoting(f);
    await f.review.finalizePreliminary(1);
    expect((await f.review.applications(1)).status).to.equal(6n);
    expect(await f.review.claimable(1, f.candidates[0].address)).to.equal(0n);
    expect(await f.review.claimable(1, f.applicant.address)).to.equal(f.deposit);
    expect(await f.review.claimable(1, f.funder.address)).to.equal(f.deposit);
  });

  it("zero votes: no division by zero and both amounts remain claimable", async function () {
    const f = await start();
    await f.provider.fulfill(1, 999);
    await endVoting(f);
    await f.review.finalizePreliminary(1);
    expect((await f.review.applications(1)).status).to.equal(6n);
    await f.review.connect(f.applicant).withdraw(1);
    await f.review.connect(f.funder).withdraw(1);
    expect(await f.token.balanceOf(await f.review.getAddress())).to.equal(0n);
  });

  it("keeps two applications' settlement accounts isolated", async function () {
    const f = await start();
    await f.review.connect(f.applicant).submit(
      f.ethers.parseEther("50000"), f.metadata
    );
    await f.review.connect(f.funder).fundAndRequest(2);
    await f.provider.fulfill(1, 111);
    await f.provider.fulfill(2, 222);
    for (const candidate of f.candidates.slice(0, 7)) {
      await f.review.connect(candidate).vote(1, true, f.evidence);
    }
    await endVoting(f);
    await f.review.finalizePreliminary(1);
    await f.review.finalizePreliminary(2);

    expect((await f.review.applications(1)).status).to.equal(4n);
    expect((await f.review.applications(2)).status).to.equal(6n);
    await f.review.connect(f.applicant).withdraw(1);
    expect(await f.review.claimable(2, f.applicant.address)).to.equal(f.deposit);
    expect(await f.token.balanceOf(await f.review.getAddress()))
      .to.equal(f.deposit * 3n);
  });
});
