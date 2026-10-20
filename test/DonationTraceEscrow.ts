import { expect } from "chai";
import { network } from "hardhat";

describe("DonationTraceEscrow", function () {
  async function fixture(approved = true) {
    const { ethers } = await network.connect();
    const signers = await ethers.getSigners();
    const [admin, applicant, funder] = signers;
    const candidates = signers.slice(3, 13);
    const donor = signers[13];
    const ngo = signers[14];
    const otherNGO = signers[15];
    const outsider = signers[16];

    const deposit = ethers.parseEther("1000");
    const amount = ethers.parseEther("100");
    const metadata = ethers.keccak256(ethers.toUtf8Bytes("application-salt"));
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("evidence-salt"));
    const allocationHash = ethers.keccak256(ethers.toUtf8Bytes("allocation-salt"));
    const usageHash = ethers.keccak256(ethers.toUtf8Bytes("usage-salt"));

    const token = await (
      await ethers.getContractFactory("MockCharityToken")
    ).deploy();
    const provider = await (
      await ethers.getContractFactory("MockRandomnessProvider")
    ).deploy();
    const review = await (
      await ethers.getContractFactory("AidApplicationReview")
    ).deploy(await token.getAddress(), await provider.getAddress());
    const escrow = await (
      await ethers.getContractFactory("DonationTraceEscrow")
    ).deploy(await token.getAddress(), await review.getAddress());

    for (const candidate of candidates) {
      await review.connect(candidate).registerCandidate();
    }

    await token.mint(applicant.address, deposit);
    await token.mint(funder.address, deposit);
    await token.mint(donor.address, amount * 3n);
    await token.connect(applicant).approve(await review.getAddress(), deposit);
    await token.connect(funder).approve(await review.getAddress(), deposit);
    await token.connect(donor).approve(await escrow.getAddress(), amount * 3n);

    await review.connect(applicant).submit(ethers.parseEther("50000"), metadata);
    await review.connect(funder).fundAndRequest(1);
    await provider.fulfill(1, 123);

    // Seven voters participate. Five determine the preliminary result.
    for (const candidate of candidates.slice(0, 5)) {
      await review.connect(candidate).vote(1, approved, evidence);
    }
    for (const candidate of candidates.slice(5, 7)) {
      await review.connect(candidate).vote(1, !approved, evidence);
    }
    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await review.finalizePreliminary(1);

    return {
      ethers, admin, applicant, donor, ngo, otherNGO, outsider,
      token, review, escrow, amount, allocationHash, usageHash,
    };
  }

  async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
    await f.escrow.authorizeNGO(f.ngo.address, true);
    await f.escrow.assignNGO(1, f.ngo.address);
  }

  it("only accepts approved applications and authorized NGOs", async function () {
    const f = await fixture(false);
    expect((await f.review.applications(1)).status).to.equal(5n);

    await expect(f.escrow.connect(f.outsider).authorizeNGO(f.ngo.address, true))
      .to.be.revertedWith("Not administrator");
    await expect(f.escrow.assignNGO(1, f.ngo.address))
      .to.be.revertedWith("NGO not authorized");

    await f.escrow.authorizeNGO(f.ngo.address, true);
    await expect(f.escrow.assignNGO(1, f.ngo.address))
      .to.be.revertedWith("Application not approved");
    await expect(f.escrow.connect(f.donor).donate(1, f.amount))
      .to.be.revertedWith("Application not approved");
  });

  it("traces donation, NGO allocation, beneficiary withdrawal and usage attestations", async function () {
    const f = await fixture();
    await expect(f.escrow.connect(f.donor).donate(1, f.amount))
      .to.be.revertedWith("No authorized NGO");
    await prepare(f);

    await f.escrow.connect(f.donor).donate(1, f.amount);
    expect(await f.escrow.donationCount()).to.equal(1n);
    expect(await f.escrow.escrowed()).to.equal(f.amount);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(f.amount);

    const donation = await f.escrow.donations(1);
    expect(donation.donor).to.equal(f.donor.address);
    expect(donation.ngo).to.equal(f.ngo.address);
    expect(donation.beneficiary).to.equal(f.applicant.address);
    expect(donation.applicationId).to.equal(1n);
    expect(donation.amount).to.equal(f.amount);
    expect(donation.state).to.equal(1n); // Donated

    await expect(f.escrow.connect(f.outsider).allocate(1, f.allocationHash))
      .to.be.revertedWith("Not authorized NGO");
    await f.escrow.connect(f.ngo).allocate(1, f.allocationHash);
    expect((await f.escrow.donations(1)).state).to.equal(2n); // Allocated
    expect(await f.token.balanceOf(f.ngo.address)).to.equal(0n);

    await expect(f.escrow.connect(f.outsider).withdraw(1))
      .to.be.revertedWith("Not beneficiary");
    await f.escrow.connect(f.applicant).withdraw(1);
    expect((await f.escrow.donations(1)).state).to.equal(3n); // Withdrawn
    expect(await f.escrow.escrowed()).to.equal(0n);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0n);
    expect(await f.token.balanceOf(f.applicant.address)).to.equal(f.amount);

    await expect(f.escrow.connect(f.applicant).withdraw(1))
      .to.be.revertedWith("Not allocated");
    await expect(f.escrow.connect(f.outsider).reportUsage(1, f.usageHash))
      .to.be.revertedWith("Not beneficiary");
    await f.escrow.connect(f.applicant).reportUsage(1, f.usageHash);
    await expect(f.escrow.connect(f.outsider).attestUsage(1))
      .to.be.revertedWith("Not authorized NGO");
    await f.escrow.connect(f.ngo).attestUsage(1);
    expect((await f.escrow.donations(1)).usageAttested).to.equal(true);
    await expect(f.escrow.connect(f.ngo).attestUsage(1))
      .to.be.revertedWith("Already attested");
    await expect(f.escrow.connect(f.donor).refund(1))
      .to.be.revertedWith("Not refundable");
  });

  it("lets only the donor refund unpaid funds after seven days", async function () {
    const f = await fixture();
    await prepare(f);
    const initialBalance = await f.token.balanceOf(f.donor.address);
    await f.escrow.connect(f.donor).donate(1, f.amount);

    await expect(f.escrow.connect(f.donor).refund(1))
      .to.be.revertedWith("Refund not available");
    await expect(f.escrow.connect(f.outsider).refund(1))
      .to.be.revertedWith("Not donor");

    await f.ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
    await f.ethers.provider.send("evm_mine", []);
    await f.escrow.connect(f.donor).refund(1);

    expect((await f.escrow.donations(1)).state).to.equal(4n); // Refunded
    expect(await f.token.balanceOf(f.donor.address)).to.equal(initialBalance);
    expect(await f.escrow.escrowed()).to.equal(0n);
    await expect(f.escrow.connect(f.donor).refund(1))
      .to.be.revertedWith("Not refundable");
  });

  it("allows immediate refund after NGO revocation, even after allocation", async function () {
    const f = await fixture();
    await prepare(f);
    await f.escrow.connect(f.donor).donate(1, f.amount);
    await f.escrow.connect(f.ngo).allocate(1, f.allocationHash);
    await f.escrow.authorizeNGO(f.ngo.address, false);

    await expect(f.escrow.connect(f.applicant).withdraw(1))
      .to.be.revertedWith("NGO revoked");

    // Reauthorization must not unlock a donation from before revocation.
    await f.escrow.authorizeNGO(f.ngo.address, true);
    await expect(f.escrow.connect(f.applicant).withdraw(1))
      .to.be.revertedWith("NGO revoked");

    await expect(f.escrow.connect(f.ngo).attestUsage(1))
      .to.be.revertedWith("Not withdrawn");
    await f.escrow.connect(f.donor).refund(1);
    expect((await f.escrow.donations(1)).state).to.equal(4n);
    await expect(f.escrow.connect(f.applicant).withdraw(1))
      .to.be.revertedWith("Not allocated");
  });

  it("keeps each donation's NGO snapshot when the application NGO changes", async function () {
    const f = await fixture();
    await prepare(f);
    await f.escrow.connect(f.donor).donate(1, f.amount);

    await f.escrow.authorizeNGO(f.otherNGO.address, true);
    await f.escrow.assignNGO(1, f.otherNGO.address);
    await f.escrow.connect(f.donor).donate(1, f.amount);

    expect((await f.escrow.donations(1)).ngo).to.equal(f.ngo.address);
    expect((await f.escrow.donations(2)).ngo).to.equal(f.otherNGO.address);
    await expect(f.escrow.connect(f.otherNGO).allocate(1, f.allocationHash))
      .to.be.revertedWith("Not authorized NGO");
    await f.escrow.connect(f.ngo).allocate(1, f.allocationHash);
    await f.escrow.connect(f.otherNGO).allocate(2, f.allocationHash);
    expect(await f.escrow.escrowed()).to.equal(f.amount * 2n);
  });
  it("keeps revoked, unallocated donations refundable after reauthorization", async function () {
    const f = await fixture();
    await prepare(f);
    await f.escrow.connect(f.donor).donate(1, f.amount);

    await f.escrow.authorizeNGO(f.ngo.address, false);
    await f.escrow.authorizeNGO(f.ngo.address, true);

    await expect(f.escrow.connect(f.ngo).allocate(1, f.allocationHash))
      .to.revert(f.ethers);
    expect((await f.escrow.donations(1)).state).to.equal(1n);

    await f.escrow.connect(f.donor).refund(1);
    expect((await f.escrow.donations(1)).state).to.equal(4n);
    expect(await f.escrow.escrowed()).to.equal(0n);
  });

  it("allows new donations after reauthorization without unlocking old ones", async function () {
    const f = await fixture();
    await prepare(f);
    await f.escrow.connect(f.donor).donate(1, f.amount);

    await f.escrow.authorizeNGO(f.ngo.address, false);
    await f.escrow.authorizeNGO(f.ngo.address, true);
    await f.escrow.connect(f.donor).donate(1, f.amount);

    await expect(f.escrow.connect(f.ngo).allocate(1, f.allocationHash))
      .to.revert(f.ethers);

    await f.escrow.connect(f.ngo).allocate(2, f.allocationHash);
    await f.escrow.connect(f.applicant).withdraw(2);
    expect((await f.escrow.donations(2)).state).to.equal(3n);
    expect(await f.escrow.escrowed()).to.equal(f.amount);

    await f.escrow.connect(f.donor).refund(1);
    expect((await f.escrow.donations(1)).state).to.equal(4n);
    expect(await f.escrow.escrowed()).to.equal(0n);
  });
  it("lets the donor refund an allocated but unwithdrawn donation after seven days", async function () {
    const f = await fixture();
    await prepare(f);
    const initialBalance = await f.token.balanceOf(f.donor.address);

    await f.escrow.connect(f.donor).donate(1, f.amount);
    await f.escrow.connect(f.ngo).allocate(1, f.allocationHash);
    expect((await f.escrow.donations(1)).state).to.equal(2n);

    await expect(f.escrow.connect(f.donor).refund(1))
      .to.revert(f.ethers);

    await f.ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
    await f.ethers.provider.send("evm_mine", []);

    await f.escrow.connect(f.donor).refund(1);
    expect((await f.escrow.donations(1)).state).to.equal(4n);
    expect(await f.escrow.escrowed()).to.equal(0n);
    expect(await f.token.balanceOf(f.donor.address)).to.equal(initialBalance);

    await expect(f.escrow.connect(f.applicant).withdraw(1))
      .to.revert(f.ethers);
    await expect(f.escrow.connect(f.donor).refund(1))
      .to.revert(f.ethers);
  });
});