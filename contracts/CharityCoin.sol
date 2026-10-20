// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Local research prototype; not connected to a real bank.
/// @dev The issuer's deposit confirmation is trusted. This contract cannot
///      independently verify RMB deposits or a fiat reserve.
contract CharityCoin {
    string public constant name = "Charity Coin";
    string public constant symbol = "CHC";
    uint8 public constant decimals = 18;

    uint256 public constant FEE_BPS = 1_000;
    uint256 public constant BPS = 10_000;
    uint256 public constant UNITS_PER_RMB_CENT = 1e16;

    address public immutable administrator;
    address public immutable bankIssuer;

    uint256 public totalSupply;
    uint256 public totalConfirmedCents;
    uint256 public totalFeeCents;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(bytes32 => bool) public processedDeposit;
    mapping(address => bool) public systemContract;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event SystemContractChanged(address indexed account, bool authorized);
    event DepositIssued(
        bytes32 indexed depositId,
        address indexed donor,
        uint256 grossCents,
        uint256 feeCents,
        uint256 mintedUnits
    );

    modifier onlyAdministrator() {
        require(msg.sender == administrator, "Not administrator");
        _;
    }

    modifier onlyBankIssuer() {
        require(msg.sender == bankIssuer, "Not bank issuer");
        _;
    }

    constructor(address issuer) {
        require(issuer != address(0), "Zero issuer");
        administrator = msg.sender;
        bankIssuer = issuer;
    }

    /// @notice Register a deployed contract as part of the local system.
    function setSystemContract(address account, bool authorized)
        external onlyAdministrator
    {
        require(account != address(0), "Zero account");
        if (authorized) {
            require(account.code.length > 0, "Not deployed contract");
        }
        systemContract[account] = authorized;
        emit SystemContractChanged(account, authorized);
    }

    /// @notice grossCents: RMB cents confirmed by the simulated bank issuer.
    /// @dev Fixed prototype rate: 1 RMB = 1 CHC before the 10% fee.
    ///      Require multiples of 10 cents to avoid rounding the fee.
    function issue(
        bytes32 depositId,
        address donor,
        uint256 grossCents
    ) external onlyBankIssuer returns (uint256 mintedUnits) {
        require(depositId != bytes32(0), "Empty deposit ID");
        require(!processedDeposit[depositId], "Deposit already issued");
        require(donor != address(0), "Zero donor");
        require(grossCents >= 10 && grossCents % 10 == 0, "Invalid cents");

        uint256 feeCents = grossCents / 10;
        mintedUnits = (grossCents - feeCents) * UNITS_PER_RMB_CENT;

        processedDeposit[depositId] = true;
        totalConfirmedCents += grossCents;
        totalFeeCents += feeCents;
        totalSupply += mintedUnits;
        balanceOf[donor] += mintedUnits;

        emit Transfer(address(0), donor, mintedUnits);
        emit DepositIssued(
            depositId, donor, grossCents, feeCents, mintedUnits
        );
    }

    /// @notice Allowances can be granted only to registered system contracts.
    function approve(address spender, uint256 amount)
        external returns (bool)
    {
        require(systemContract[spender], "Spender not system contract");
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external returns (bool)
    {
        require(systemContract[msg.sender], "Caller not system contract");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "Insufficient allowance");
        allowance[from][msg.sender] = allowed - amount;
        emit Approval(from, msg.sender, allowed - amount);
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "Zero recipient");
        require(
            systemContract[from] || systemContract[to],
            "Wallet transfers disabled"
        );
        uint256 available = balanceOf[from];
        require(available >= amount, "Insufficient balance");
        balanceOf[from] = available - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}