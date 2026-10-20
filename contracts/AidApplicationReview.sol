// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IApplicationToken {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount)
        external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IRandomnessRequester {
    function requestRandomness(uint256 applicationId)
        external returns (uint256 requestId);
}

/// @notice Local prototype only. No donation entry and no appeal.
/// @dev Replace the mock token and randomness provider before any production use.
contract AidApplicationReview {
    enum Status {
        None,
        AwaitingFunding,
        AwaitingRandomness,
        Voting,
        PreliminaryApproved,
        PreliminaryRejected,
        Inconclusive,
        Expired
    }

    struct Application {
        address applicant;
        bytes32 metadataHash;
        uint256 target;
        uint256 deposit;
        uint256 verifierCount;
        uint256 requestId;
        uint256 deadline;
        uint256 approvals;
        uint256 rejections;
        Status status;
    }

    uint256 public constant GOAL_STEP = 50_000 ether;
    uint256 public constant DEPOSIT_STEP = 1_000 ether;
    uint256 public constant VERIFIERS_PER_STEP = 10;
    uint256 public constant MAX_STEPS = 10;
    uint256 public constant MAX_CANDIDATES = 200;
    uint256 public constant VOTING_PERIOD = 3 days;
    uint256 public constant FUNDING_TIMEOUT = 3 days;
    uint256 public constant RANDOMNESS_TIMEOUT = 3 days;

    IApplicationToken public immutable token;
    address public immutable randomnessProvider;
    uint256 public applicationCount;

    address[] public candidatePool;
    mapping(address => bool) public isCandidate;
    mapping(uint256 => Application) public applications;
    mapping(uint256 => uint256) public submittedAt;
    mapping(uint256 => uint256) public randomnessRequestedAt;
    mapping(uint256 => address[]) private candidateSnapshots;
    mapping(uint256 => address[]) private selectedVerifiers;
    mapping(uint256 => mapping(address => bool)) public selected;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => bytes32)) public evidenceHashes;
    mapping(uint256 => uint256) public applicationByRequest;

    // Each application has exactly one reward funder.
    mapping(uint256 => address) public rewardFunder;
    // Funds are credited at finalization and withdrawn by their owners.
    mapping(uint256 => mapping(address => uint256)) public claimable;

    bool private entered;

    event CandidateRegistered(address indexed candidate);
    event ApplicationSubmitted(
        uint256 indexed applicationId,
        address indexed applicant,
        uint256 target,
        uint256 deposit,
        uint256 verifierCount
    );
    event RandomnessRequested(uint256 indexed applicationId, uint256 requestId);
    event VerifiersSelected(uint256 indexed applicationId, uint256 deadline);
    event VoteRecorded(
        uint256 indexed applicationId,
        address indexed verifier,
        bool authentic,
        bytes32 evidenceHash
    );
    // Existing event and enum names retained for compatibility.
    // These decisions are final in this no-appeal prototype.
    event PreliminaryDecision(uint256 indexed applicationId, Status status);
    event SettlementCredited(
        uint256 indexed applicationId,
        address indexed recipient,
        uint256 amount
    );
    event Withdrawn(
        uint256 indexed applicationId,
        address indexed recipient,
        uint256 amount
    );

    event ApplicationExpired(uint256 indexed applicationId, Status previousStatus);

    modifier nonReentrant() {
        require(!entered, "Reentrant call");
        entered = true;
        _;
        entered = false;
    }

    constructor(address tokenAddress, address providerAddress) {
        require(tokenAddress != address(0), "Zero token");
        require(providerAddress != address(0), "Zero provider");
        token = IApplicationToken(tokenAddress);
        randomnessProvider = providerAddress;
    }

    // Registration does not establish real-world identity or Sybil resistance.
    function registerCandidate() external {
        require(!isCandidate[msg.sender], "Already registered");
        require(candidatePool.length < MAX_CANDIDATES, "Pool full");
        isCandidate[msg.sender] = true;
        candidatePool.push(msg.sender);
        emit CandidateRegistered(msg.sender);
    }

    function quote(uint256 target)
        public pure returns (uint256 deposit, uint256 verifierCount)
    {
        require(target > 0 && target <= GOAL_STEP * MAX_STEPS, "Invalid target");
        uint256 steps = (target - 1) / GOAL_STEP + 1;
        return (steps * DEPOSIT_STEP, steps * VERIFIERS_PER_STEP);
    }

    /// @param metadataHash Hash of salted metadata; do not publish medical files.
    function submit(uint256 target, bytes32 metadataHash)
        external nonReentrant returns (uint256 applicationId)
    {
        require(metadataHash != bytes32(0), "Missing metadata hash");
        (uint256 deposit, uint256 count) = quote(target);

        applicationId = ++applicationCount;
        address[] storage snapshot = candidateSnapshots[applicationId];
        for (uint256 i = 0; i < candidatePool.length; ++i) {
            if (candidatePool[i] != msg.sender) {
                snapshot.push(candidatePool[i]);
            }
        }
        require(snapshot.length >= count, "Not enough candidates");

        submittedAt[applicationId] = block.timestamp;
        applications[applicationId] = Application({
            applicant: msg.sender,
            metadataHash: metadataHash,
            target: target,
            deposit: deposit,
            verifierCount: count,
            requestId: 0,
            deadline: 0,
            approvals: 0,
            rejections: 0,
            status: Status.AwaitingFunding
        });

        _receiveExact(msg.sender, deposit);
        emit ApplicationSubmitted(
            applicationId, msg.sender, target, deposit, count
        );
    }

    // A single funder prepays an amount equal to the application deposit.
    function fundAndRequest(uint256 applicationId) external nonReentrant {
        Application storage application = applications[applicationId];
        require(
            application.status == Status.AwaitingFunding,
            "Not awaiting funding"
        );

        require(block.timestamp < submittedAt[applicationId] + FUNDING_TIMEOUT, "Funding timed out");
        _receiveExact(msg.sender, application.deposit);
        rewardFunder[applicationId] = msg.sender;
        application.status = Status.AwaitingRandomness;
        randomnessRequestedAt[applicationId] = block.timestamp;

        uint256 requestId =
            IRandomnessRequester(randomnessProvider).requestRandomness(
                applicationId
            );
        require(requestId != 0, "Zero request ID");
        require(applicationByRequest[requestId] == 0, "Duplicate request ID");

        application.requestId = requestId;
        applicationByRequest[requestId] = applicationId;
        emit RandomnessRequested(applicationId, requestId);
    }

    // Production provider must itself verify the VRF callback.
    function fulfillRandomness(uint256 requestId, uint256 randomWord)
        external nonReentrant
    {
        require(msg.sender == randomnessProvider, "Unauthorized provider");
        uint256 applicationId = applicationByRequest[requestId];
        require(applicationId != 0, "Unknown request");

        Application storage application = applications[applicationId];
        require(
            application.status == Status.AwaitingRandomness,
            "Request already fulfilled"
        );
        require(block.timestamp < randomnessRequestedAt[applicationId] + RANDOMNESS_TIMEOUT, "Randomness timed out");
        application.status = Status.Voting;
        application.deadline = block.timestamp + VOTING_PERIOD;

        address[] memory pool = candidateSnapshots[applicationId];
        for (uint256 i = 0; i < application.verifierCount; ++i) {
            uint256 index = i +
                uint256(keccak256(abi.encode(randomWord, applicationId, i)))
                % (pool.length - i);
            (pool[i], pool[index]) = (pool[index], pool[i]);

            address verifier = pool[i];
            selected[applicationId][verifier] = true;
            selectedVerifiers[applicationId].push(verifier);
        }

        emit VerifiersSelected(applicationId, application.deadline);
    }

    function vote(uint256 applicationId, bool authentic, bytes32 evidenceHash)
        external
    {
        Application storage application = applications[applicationId];
        require(application.status == Status.Voting, "Not voting");
        require(block.timestamp < application.deadline, "Voting ended");
        require(selected[applicationId][msg.sender], "Not selected");
        require(!hasVoted[applicationId][msg.sender], "Already voted");
        require(evidenceHash != bytes32(0), "Missing evidence hash");

        hasVoted[applicationId][msg.sender] = true;
        evidenceHashes[applicationId][msg.sender] = evidenceHash;
        if (authentic) {
            ++application.approvals;
        } else {
            ++application.rejections;
        }

        emit VoteRecorded(applicationId, msg.sender, authentic, evidenceHash);
    }

    // Permissionless, final, once-only settlement after the voting deadline.
    function finalizePreliminary(uint256 applicationId) external {
        Application storage application = applications[applicationId];
        require(application.status == Status.Voting, "Not voting");
        require(block.timestamp >= application.deadline, "Voting still open");

        uint256 votes = application.approvals + application.rejections;
        uint256 participationThreshold =
            (application.verifierCount * 2 + 2) / 3;

        if (votes < participationThreshold) {
            application.status = Status.Inconclusive;
        } else {
            uint256 consensusThreshold = (votes * 2 + 2) / 3;
            if (application.approvals >= consensusThreshold) {
                application.status = Status.PreliminaryApproved;
            } else if (application.rejections >= consensusThreshold) {
                application.status = Status.PreliminaryRejected;
            } else {
                application.status = Status.Inconclusive;
            }
        }

        address funder = rewardFunder[applicationId];
        uint256 deposit = application.deposit;

        if (application.status == Status.Inconclusive) {
            _credit(applicationId, application.applicant, deposit);
            _credit(applicationId, funder, deposit);
        } else {
            // Approval: funder pays voters, applicant gets deposit.
            // Rejection: applicant's deposit pays voters, funder gets refund.
            address remainderOwner;
            if (application.status == Status.PreliminaryApproved) {
                _credit(applicationId, application.applicant, deposit);
                remainderOwner = funder;
            } else {
                _credit(applicationId, funder, deposit);
                remainderOwner = application.applicant;
            }

            uint256 share = deposit / votes;
            uint256 distributed;
            address[] storage verifiers = selectedVerifiers[applicationId];
            for (uint256 i = 0; i < verifiers.length; ++i) {
                if (hasVoted[applicationId][verifiers[i]]) {
                    _credit(applicationId, verifiers[i], share);
                    distributed += share;
                }
            }
            // Return rounding dust to the original owner of the split pot.
            _credit(applicationId, remainderOwner, deposit - distributed);
        }

        emit PreliminaryDecision(applicationId, application.status);
    }

    // Anyone can close a timed-out application; owners withdraw their own credits.
    function expireApplication(uint256 applicationId) external {
        Application storage application = applications[applicationId];
        Status previousStatus = application.status;

        if (previousStatus == Status.AwaitingFunding) {
            require(
                block.timestamp >= submittedAt[applicationId] + FUNDING_TIMEOUT,
                "Funding still open"
            );
            application.status = Status.Expired;
            _credit(applicationId, application.applicant, application.deposit);
        } else if (previousStatus == Status.AwaitingRandomness) {
            require(
                block.timestamp >= randomnessRequestedAt[applicationId] + RANDOMNESS_TIMEOUT,
                "Randomness still pending"
            );
            application.status = Status.Expired;
            _credit(applicationId, application.applicant, application.deposit);
            _credit(applicationId, rewardFunder[applicationId], application.deposit);
        } else {
            revert("Not expirable");
        }

        emit ApplicationExpired(applicationId, previousStatus);
    }

    function withdraw(uint256 applicationId) external nonReentrant {
        uint256 amount = claimable[applicationId][msg.sender];
        require(amount != 0, "Nothing to withdraw");
        claimable[applicationId][msg.sender] = 0;
        _sendExact(msg.sender, amount);
        emit Withdrawn(applicationId, msg.sender, amount);
    }

    function getSelectedVerifiers(uint256 applicationId)
        external view returns (address[] memory)
    {
        return selectedVerifiers[applicationId];
    }

    function _credit(uint256 applicationId, address recipient, uint256 amount)
        private
    {
        if (amount == 0) return;
        claimable[applicationId][recipient] += amount;
        emit SettlementCredited(applicationId, recipient, amount);
    }

    function _receiveExact(address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        require(token.transferFrom(from, address(this), amount), "Transfer failed");
        require(
            token.balanceOf(address(this)) == beforeBalance + amount,
            "Non-exact token transfer"
        );
    }

    function _sendExact(address to, uint256 amount) private {
        uint256 beforeContract = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(to);
        require(token.transfer(to, amount), "Transfer failed");
        require(
            token.balanceOf(address(this)) == beforeContract - amount &&
                token.balanceOf(to) == beforeRecipient + amount,
            "Non-exact token transfer"
        );
    }
}
