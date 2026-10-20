// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRandomnessConsumerForTest {
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external;
}

contract MockCharityToken {
    string public constant name = "Local Test Charity Token";
    string public constant symbol = "TEST";
    uint8 public constant decimals = 18;

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
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "Insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract MockRandomnessProvider {
    uint256 public nextRequestId;
    mapping(uint256 => address) public requester;

    function requestRandomness(uint256) external returns (uint256 requestId) {
        requestId = ++nextRequestId;
        requester[requestId] = msg.sender;
    }

    // Insecure: anyone can call this. Local tests only.
    function fulfill(uint256 requestId, uint256 randomWord) external {
        address consumer = requester[requestId];
        require(consumer != address(0), "Unknown request");
        IRandomnessConsumerForTest(consumer).fulfillRandomness(
            requestId, randomWord
        );
    }
}
