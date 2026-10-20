// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITraceToken {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount)
        external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ITraceReview {
    function applications(uint256 applicationId) external view returns (
        address applicant,
        bytes32 metadataHash,
        uint256 target,
        uint256 deposit,
        uint256 verifierCount,
        uint256 requestId,
        uint256 deadline,
        uint256 approvals,
        uint256 rejections,
        uint8 status
    );
}

/// @notice Local prototype: one donation is traced as one indivisible unit.
/// @dev NGO assignment is an authorization, not a transfer to an NGO wallet.
///      Usage records are attestations, NOT proof of real-world expenditure.
contract DonationTraceEscrow {
    enum State {
        None,
        Donated,
        Allocated,
        Withdrawn,
        Refunded
    }

    struct Donation {
        address donor;
        address ngo;
        address beneficiary;
        uint256 applicationId;
        uint256 amount;
        uint256 createdAt;
        uint256 allocatedAt;
        bytes32 allocationHash;
        bytes32 usageHash;
        bool usageAttested;
        State state;
    }

    uint8 private constant APPROVED = 4;
    uint256 public constant REFUND_DELAY = 7 days;

    address public immutable administrator;
    ITraceToken public immutable token;
    ITraceReview public immutable review;
    uint256 public donationCount;
    uint256 public escrowed;
    bool private entered;

    mapping(address => bool) public authorizedNGO;
    mapping(address => uint256) public ngoRevocationEpoch;
    mapping(uint256 => uint256) public donationNGOEpoch;
    mapping(uint256 => address) public applicationNGO;
    mapping(uint256 => Donation) public donations;

    event NGOAuthorizationChanged(address indexed ngo, bool authorized);
    event ApplicationNGOChanged(uint256 indexed applicationId, address indexed ngo);
    event Donated(
        uint256 indexed donationId,
        uint256 indexed applicationId,
        address indexed donor,
        address ngo,
        address beneficiary,
        uint256 amount
    );
    event Allocated(
        uint256 indexed donationId,
        address indexed ngo,
        bytes32 allocationHash
    );
    event BeneficiaryWithdrawn(
        uint256 indexed donationId,
        address indexed beneficiary,
        uint256 amount
    );
    event DonationRefunded(
        uint256 indexed donationId,
        address indexed donor,
        uint256 amount
    );
    event UsageReported(uint256 indexed donationId, bytes32 usageHash);
    event UsageAttested(uint256 indexed donationId, address indexed ngo);

    modifier onlyAdministrator() {
        require(msg.sender == administrator, "Not administrator");
        _;
    }

    modifier nonReentrant() {
        require(!entered, "Reentrant call");
        entered = true;
        _;
        entered = false;
    }

    constructor(address tokenAddress, address reviewAddress) {
        require(tokenAddress != address(0) && reviewAddress != address(0),
            "Zero address");
        administrator = msg.sender;
        token = ITraceToken(tokenAddress);
        review = ITraceReview(reviewAddress);
    }

    function authorizeNGO(address ngo, bool authorized)
        external onlyAdministrator
    {
        require(ngo != address(0), "Zero NGO");
        if (authorizedNGO[ngo] && !authorized) {
            ++ngoRevocationEpoch[ngo];
        }
        authorizedNGO[ngo] = authorized;
        emit NGOAuthorizationChanged(ngo, authorized);
    }

    function assignNGO(uint256 applicationId, address ngo)
        external onlyAdministrator
    {
        require(authorizedNGO[ngo], "NGO not authorized");
        _approvedApplicant(applicationId);
        applicationNGO[applicationId] = ngo;
        emit ApplicationNGOChanged(applicationId, ngo);
    }

    /// @notice Locks tokens for an approved applicant and snapshots the NGO.
    function donate(uint256 applicationId, uint256 amount)
        external nonReentrant returns (uint256 donationId)
    {
        require(amount > 0, "Zero amount");
        address beneficiary = _approvedApplicant(applicationId);
        address ngo = applicationNGO[applicationId];
        require(authorizedNGO[ngo], "No authorized NGO");

        donationId = ++donationCount;
        donations[donationId] = Donation({
            donor: msg.sender,
            ngo: ngo,
            beneficiary: beneficiary,
            applicationId: applicationId,
            amount: amount,
            createdAt: block.timestamp,
            allocatedAt: 0,
            allocationHash: bytes32(0),
            usageHash: bytes32(0),
            usageAttested: false,
            state: State.Donated
        });
        donationNGOEpoch[donationId] = ngoRevocationEpoch[ngo];
        escrowed += amount;
        _receiveExact(msg.sender, amount);

        emit Donated(
            donationId, applicationId, msg.sender, ngo, beneficiary, amount
        );
    }

    /// @notice NGO authorizes release; tokens stay in escrow until withdrawn.
    function allocate(uint256 donationId, bytes32 allocationHash) external {
        Donation storage d = donations[donationId];
        require(d.state == State.Donated, "Not donated");
        require(donationNGOEpoch[donationId] == ngoRevocationEpoch[d.ngo],
            "NGO revoked");
        require(msg.sender == d.ngo && authorizedNGO[msg.sender],
            "Not authorized NGO");
        require(allocationHash != bytes32(0), "Missing allocation hash");
        require(_approvedApplicant(d.applicationId) == d.beneficiary,
            "Approval changed");

        d.allocationHash = allocationHash;
        d.allocatedAt = block.timestamp;
        d.state = State.Allocated;
        emit Allocated(donationId, msg.sender, allocationHash);
    }

    /// @notice The beneficiary, not the NGO, receives the escrowed tokens.
    function withdraw(uint256 donationId) external nonReentrant {
        Donation storage d = donations[donationId];
        require(d.state == State.Allocated, "Not allocated");
        require(msg.sender == d.beneficiary, "Not beneficiary");

        require(authorizedNGO[d.ngo] &&
                donationNGOEpoch[donationId] == ngoRevocationEpoch[d.ngo],
            "NGO revoked");
        d.state = State.Withdrawn;
        escrowed -= d.amount;
        _sendExact(msg.sender, d.amount);
        emit BeneficiaryWithdrawn(donationId, msg.sender, d.amount);
    }

    /// @notice A donor can recover an unpaid donation after the timeout.
    function refund(uint256 donationId) external nonReentrant {
        Donation storage d = donations[donationId];
        require(msg.sender == d.donor, "Not donor");
        require(d.state == State.Donated || d.state == State.Allocated,
            "Not refundable");
        require(
            block.timestamp >= d.createdAt + REFUND_DELAY ||
            !authorizedNGO[d.ngo] ||
            donationNGOEpoch[donationId] != ngoRevocationEpoch[d.ngo],
            "Refund not available"
        );

        d.state = State.Refunded;
        escrowed -= d.amount;
        _sendExact(msg.sender, d.amount);
        emit DonationRefunded(donationId, msg.sender, d.amount);
    }

    /// @notice A hash alone is not evidence that spending really happened.
    function reportUsage(uint256 donationId, bytes32 usageHash) external {
        Donation storage d = donations[donationId];
        require(d.state == State.Withdrawn, "Not withdrawn");
        require(msg.sender == d.beneficiary, "Not beneficiary");
        require(d.usageHash == bytes32(0), "Already reported");
        require(usageHash != bytes32(0), "Missing usage hash");

        d.usageHash = usageHash;
        emit UsageReported(donationId, usageHash);
    }

    function attestUsage(uint256 donationId) external {
        Donation storage d = donations[donationId];
        require(d.state == State.Withdrawn, "Not withdrawn");
        require(d.usageHash != bytes32(0), "No usage report");
        require(!d.usageAttested, "Already attested");
        require(msg.sender == d.ngo && authorizedNGO[msg.sender],
            "Not authorized NGO");

        d.usageAttested = true;
        emit UsageAttested(donationId, msg.sender);
    }

    function _approvedApplicant(uint256 applicationId)
        private view returns (address applicant)
    {
        uint8 status;
        (applicant, , , , , , , , , status) =
            review.applications(applicationId);
        require(applicant != address(0) && status == APPROVED,
            "Application not approved");
    }

    // This prototype accepts only ordinary, non-fee-on-transfer tokens.
    function _receiveExact(address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        require(token.transferFrom(from, address(this), amount),
            "Transfer from failed");
        require(token.balanceOf(address(this)) - beforeBalance == amount,
            "Incorrect amount received");
    }

    function _sendExact(address to, uint256 amount) private {
        uint256 beforeEscrow = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(to);
        require(token.transfer(to, amount), "Transfer failed");
        require(beforeEscrow - token.balanceOf(address(this)) == amount &&
                token.balanceOf(to) - beforeRecipient == amount,
            "Incorrect amount sent");
    }
}
