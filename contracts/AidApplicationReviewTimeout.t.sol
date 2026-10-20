// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AidApplicationReview} from "./AidApplicationReview.sol";

contract TimeoutTestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external returns (bool)
    {
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        require(balanceOf[from] >= amount, "Insufficient balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract TimeoutTestProvider {
    uint256 public nextId;

    function requestRandomness(uint256) external returns (uint256) {
        return ++nextId;
    }

    function deliver(AidApplicationReview review, uint256 requestId) external {
        review.fulfillRandomness(requestId, 12345);
    }
}

contract AidApplicationReviewTimeoutTest is Test {
    AidApplicationReview internal review;
    TimeoutTestToken internal token;
    TimeoutTestProvider internal provider;

    address internal applicant = address(11);
    address internal funder = address(12);
    uint256 internal constant DEPOSIT = 1_000 ether;

    function setUp() public {
        token = new TimeoutTestToken();
        provider = new TimeoutTestProvider();
        review = new AidApplicationReview(address(token), address(provider));

        for (uint160 i = 100; i < 110; ++i) {
            vm.prank(address(i));
            review.registerCandidate();
        }

        token.mint(applicant, DEPOSIT);
        token.mint(funder, DEPOSIT);

        vm.prank(applicant);
        token.approve(address(review), DEPOSIT);
        vm.prank(funder);
        token.approve(address(review), DEPOSIT);
    }

    function _submit() internal {
        vm.prank(applicant);
        review.submit(50_000 ether, bytes32(uint256(1)));
    }

    function test_FundingTimeoutRefundOnce() public {
        _submit();

        vm.warp(block.timestamp + review.FUNDING_TIMEOUT());

        vm.prank(funder);
        vm.expectRevert(bytes("Funding timed out"));
        review.fundAndRequest(1);

        review.expireApplication(1);
        assertEq(review.claimable(1, applicant), DEPOSIT);
        assertEq(review.claimable(1, funder), 0);

        vm.expectRevert(bytes("Not expirable"));
        review.expireApplication(1);

        vm.prank(applicant);
        review.withdraw(1);
        assertEq(token.balanceOf(applicant), DEPOSIT);
        assertEq(review.claimable(1, applicant), 0);

        vm.prank(applicant);
        vm.expectRevert(bytes("Nothing to withdraw"));
        review.withdraw(1);
    }

    function test_RandomnessTimeoutRefundsBothOnce() public {
        _submit();

        vm.prank(funder);
        review.fundAndRequest(1);

        vm.warp(block.timestamp + review.RANDOMNESS_TIMEOUT());

        vm.expectRevert(bytes("Randomness timed out"));
        provider.deliver(review, 1);

        review.expireApplication(1);
        assertEq(review.claimable(1, applicant), DEPOSIT);
        assertEq(review.claimable(1, funder), DEPOSIT);

        vm.expectRevert(bytes("Not expirable"));
        review.expireApplication(1);

        vm.expectRevert(bytes("Request already fulfilled"));
        provider.deliver(review, 1);

        vm.prank(applicant);
        review.withdraw(1);
        vm.prank(funder);
        review.withdraw(1);

        assertEq(token.balanceOf(applicant), DEPOSIT);
        assertEq(token.balanceOf(funder), DEPOSIT);
        assertEq(token.balanceOf(address(review)), 0);

        vm.prank(applicant);
        vm.expectRevert(bytes("Nothing to withdraw"));
        review.withdraw(1);
        vm.prank(funder);
        vm.expectRevert(bytes("Nothing to withdraw"));
        review.withdraw(1);
    }

    function test_FulfilledRequestCannotUseTimeoutRefund() public {
        _submit();

        vm.prank(funder);
        review.fundAndRequest(1);
        provider.deliver(review, 1);

        vm.warp(block.timestamp + review.RANDOMNESS_TIMEOUT());

        vm.expectRevert(bytes("Not expirable"));
        review.expireApplication(1);

        review.finalizePreliminary(1);
        assertEq(review.claimable(1, applicant), DEPOSIT);
        assertEq(review.claimable(1, funder), DEPOSIT);

        vm.expectRevert(bytes("Not expirable"));
        review.expireApplication(1);
    }
}