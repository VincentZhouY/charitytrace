// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RejectingCharity {
    receive() external payable {
        revert("Receiver rejects ETH");
    }
}
