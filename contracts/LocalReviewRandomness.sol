// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test-only provider. Anyone can deliver a chosen value.
/// @dev NOT secure randomness; never use for a real review or public deployment.
contract LocalReviewRandomness {
    uint256 public nextId;
    mapping(uint256 => address) public requester;

    function requestRandomness(uint256) external returns (uint256 requestId) {
        requestId = ++nextId;
        requester[requestId] = msg.sender;
    }

    function deliver(uint256 requestId, uint256 randomWord) external {
        address review = requester[requestId];
        require(review != address(0), "Unknown request");

        (bool success, ) = review.call(
            abi.encodeWithSignature(
                "fulfillRandomness(uint256,uint256)",
                requestId,
                randomWord
            )
        );
        require(success, "Delivery failed");
    }
}