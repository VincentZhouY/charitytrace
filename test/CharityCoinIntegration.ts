import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { network } from "hardhat";

describe("CharityCoin — review and donation integration", function () {
  it("runs approval, donation, withdrawal and seven-day refund with CHC", async function () {
    // Use the API already confirmed working in this project's earlier test.
    const { ethers } = await network.connect();
    const signers = await ethers.getSigners();
    const [administrator, issuer, applicant, funder, donor, ngo] = signers;
    const verifierSigners = signers.slice(6, 16);
    assert.equal(verifierSigners.length, 10);

    const coin = await (
      await ethers.getContractFactory("CharityCoin", administrator)
    ).deploy(issuer.address);
    await coin.waitForDeployment();

    const randomness = await (
      await ethers.getContractFactory("LocalReviewRandomness", administrator)
    ).deploy();
    await randomness.waitForDeployment();

    const review = await (
      await ethers.getContractFactory("AidApplicationReview", administrator)
    ).deploy(await coin.getAddress(), await randomness.getAddress());
    await review.waitForDeployment();

    const escrow = await (
      await ethers.getContractFactory("DonationTraceEscrow", administrator)
    ).deploy(await coin.getAddress(), await review.getAddress());
    await escrow.waitForDeployment();

    await (await coin.setSystemContract(await review.getAddress(), true)).wait();
    await (await coin.setSystemContract(await escrow.getAddress(), true)).wait();

    // Simulated bank records, NOT actual RMB receipts.
    // Applicant and funder each receive 1,800 CHC; donor receives 900 CHC.
    await (
      await coin.connect(issuer).issue(
        ethers.id("integration-applicant"), applicant.address, 200_000n
      )
    ).wait();
    await (
      await coin.connect(issuer).issue(
        ethers.id("integration-funder"), funder.address, 200_000n
      )
    ).wait();
    await (
      await coin.connect(issuer).issue(
        ethers.id("integration-donor"), donor.address, 100_000n
      )
    ).wait();

    const deposit = ethers.parseEther("1000");
    const target = ethers.parseEther("50000");
    const donationAmount = ethers.parseEther("200");
    const refundableAmount = ethers.parseEther("100");

    await (
      await coin.connect(applicant).approve(await review.getAddress(), deposit)
    ).wait();
    await (
      await coin.connect(funder).approve(await review.getAddress(), deposit)
    ).wait();
    await (
      await coin.connect(donor).approve(
        await escrow.getAddress(), donationAmount + refundableAmount
      )
    ).wait();

    for (const verifier of verifierSigners) {
      await (await review.connect(verifier).registerCandidate()).wait();
    }

    await (
      await review.connect(applicant).submit(
        target, ethers.id("salted-application-metadata")
      )
    ).wait();
    const applicationId = await review.applicationCount();
    assert.equal(applicationId, 1n);
    assert.equal((await review.quote(target))[0], deposit);
    assert.equal((await review.applications(applicationId)).status, 1n);
    assert.equal(await coin.balanceOf(await review.getAddress()), deposit);

    await (await review.connect(funder).fundAndRequest(applicationId)).wait();
    assert.equal(await coin.balanceOf(await review.getAddress()), 2n * deposit);

    const requestId = (await review.applications(applicationId)).requestId;
    await (await randomness.deliver(requestId, 12345n)).wait();

    const selected = await review.getSelectedVerifiers(applicationId);
    assert.equal(selected.length, 10);
    for (const address of selected) {
      const verifier = verifierSigners.find(
        (s) => s.address.toLowerCase() === address.toLowerCase()
      );
      assert.ok(verifier, "Selected verifier must be a registered signer");
      await (
        await review.connect(verifier).vote(
          applicationId, true, ethers.id(`evidence-${address}`)
        )
      ).wait();
    }

    // Move beyond the voting deadline on the simulated local chain.
    await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await review.finalizePreliminary(applicationId)).wait();

    // Enum value 4 is PreliminaryApproved, as read by DonationTraceEscrow.
    assert.equal((await review.applications(applicationId)).status, 4n);
    assert.equal(
      await review.claimable(applicationId, applicant.address), deposit
    );
    assert.equal(
      await review.claimable(applicationId, selected[0]), deposit / 10n
    );

    await (await review.connect(applicant).withdraw(applicationId)).wait();
    assert.equal(await coin.balanceOf(applicant.address), ethers.parseEther("1800"));

    await (await escrow.authorizeNGO(ngo.address, true)).wait();
    await (await escrow.assignNGO(applicationId, ngo.address)).wait();

    await (
      await escrow.connect(donor).donate(applicationId, donationAmount)
    ).wait();
    const firstDonationId = await escrow.donationCount();
    assert.equal((await escrow.donations(firstDonationId)).state, 1n);
    assert.equal(await escrow.escrowed(), donationAmount);

    await (
      await escrow.connect(ngo).allocate(
        firstDonationId, ethers.id("allocation-one")
      )
    ).wait();
    await (await escrow.connect(applicant).withdraw(firstDonationId)).wait();
    assert.equal((await escrow.donations(firstDonationId)).state, 3n);
    assert.equal(await coin.balanceOf(applicant.address), ethers.parseEther("2000"));

    // Separate donation: allocated but not withdrawn, then refunded after 7 days.
    await (
      await escrow.connect(donor).donate(applicationId, refundableAmount)
    ).wait();
    const secondDonationId = await escrow.donationCount();
    await (
      await escrow.connect(ngo).allocate(
        secondDonationId, ethers.id("allocation-two")
      )
    ).wait();

    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await escrow.connect(donor).refund(secondDonationId)).wait();

    assert.equal((await escrow.donations(secondDonationId)).state, 4n);
    assert.equal(await escrow.escrowed(), 0n);
    assert.equal(await coin.balanceOf(await escrow.getAddress()), 0n);
    assert.equal(await coin.balanceOf(donor.address), ethers.parseEther("700"));
    assert.equal(await coin.totalSupply(), ethers.parseEther("4500"));
  });
});