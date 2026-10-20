// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract CharityVault {
    enum ProjectStatus {
        Pending,
        Approved,
        Rejected,
        Expired
    }

    struct Project {
        address creator;
        bytes32 metadataHash;
    }

    struct Review {
        uint256 creationBlock;
        uint256 deadline;
        uint256 approvals;
        uint256 rejections;
        ProjectStatus status;
    }

    uint256 public constant VERIFIER_STAKE = 0.1 ether;
    uint256 public constant REVIEW_PERIOD = 3 days;
    uint256 public constant MIN_VOTES = 3;

    uint256 public projectCount;
    mapping(uint256 => Project) public projects;
    mapping(uint256 => Review) public reviews;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    mapping(address => uint256) public verifierStakes;
    mapping(address => uint256) public registeredAtBlock;
    mapping(address => uint256) public latestVoteDeadline;
    uint256 public totalVerifierStakes;

    mapping(uint256 => uint256) public projectBalances;
    mapping(uint256 => mapping(address => uint256)) public projectDonations;
    mapping(address => uint256) public donations;
    mapping(address => uint256) public unallocatedByDonor;
    uint256 public totalDonations;
    uint256 public unallocatedDonations;

    event Donated(address indexed donor, uint256 amount);
    event ProjectCreated(
        uint256 indexed projectId,
        address indexed creator,
        bytes32 metadataHash
    );
    event ProjectDonation(
        uint256 indexed projectId,
        address indexed donor,
        uint256 amount
    );
    event ProjectRefunded(
        uint256 indexed projectId,
        address indexed donor,
        uint256 amount
    );
    event UnallocatedDonationRefunded(address indexed donor, uint256 amount);
    event VerifierRegistered(address indexed verifier);
    event VerifierExited(address indexed verifier);
    event VoteCast(
        uint256 indexed projectId,
        address indexed verifier,
        bool approve
    );
    event ReviewFinalized(uint256 indexed projectId, ProjectStatus status);

    function registerVerifier() external payable {
        require(verifierStakes[msg.sender] == 0, "Already registered");
        require(msg.value == VERIFIER_STAKE, "Incorrect verifier stake");

        verifierStakes[msg.sender] = msg.value;
        registeredAtBlock[msg.sender] = block.number;
        totalVerifierStakes += msg.value;

        emit VerifierRegistered(msg.sender);
    }

    function exitVerifier() external {
        uint256 stake = verifierStakes[msg.sender];
        require(stake != 0, "Not a verifier");
        require(block.timestamp >= latestVoteDeadline[msg.sender], "Vote still open");

        verifierStakes[msg.sender] = 0;
        registeredAtBlock[msg.sender] = 0;
        totalVerifierStakes -= stake;

        (bool sent, ) = payable(msg.sender).call{value: stake}("");
        require(sent, "Stake refund failed");

        emit VerifierExited(msg.sender);
    }

    function createProject(bytes32 metadataHash) external returns (uint256 projectId) {
        require(metadataHash != bytes32(0), "Project metadata hash is required");

        projectId = ++projectCount;
        projects[projectId] = Project({
            creator: msg.sender,
            metadataHash: metadataHash
        });
        reviews[projectId] = Review({
            creationBlock: block.number,
            deadline: block.timestamp + REVIEW_PERIOD,
            approvals: 0,
            rejections: 0,
            status: ProjectStatus.Pending
        });

        emit ProjectCreated(projectId, msg.sender, metadataHash);
    }

    function voteOnProject(uint256 projectId, bool approve) external {
        require(projectId > 0 && projectId <= projectCount, "Invalid project");

        Review storage review = reviews[projectId];
        require(review.status == ProjectStatus.Pending, "Review closed");
        require(block.timestamp < review.deadline, "Voting period ended");
        require(verifierStakes[msg.sender] == VERIFIER_STAKE, "Not a verifier");
        require(
            registeredAtBlock[msg.sender] < review.creationBlock,
            "Register before project creation"
        );
        require(msg.sender != projects[projectId].creator, "Creator cannot vote");
        require(!hasVoted[projectId][msg.sender], "Already voted");

        hasVoted[projectId][msg.sender] = true;
        if (approve) {
            review.approvals++;
        } else {
            review.rejections++;
        }

        if (latestVoteDeadline[msg.sender] < review.deadline) {
            latestVoteDeadline[msg.sender] = review.deadline;
        }

        emit VoteCast(projectId, msg.sender, approve);
    }

    function finalizeReview(uint256 projectId) external {
        require(projectId > 0 && projectId <= projectCount, "Invalid project");

        Review storage review = reviews[projectId];
        require(review.status == ProjectStatus.Pending, "Review closed");
        require(block.timestamp >= review.deadline, "Voting period still open");

        uint256 votes = review.approvals + review.rejections;
        if (votes < MIN_VOTES) {
            review.status = ProjectStatus.Expired;
        } else if (review.approvals * 3 >= votes * 2) {
            review.status = ProjectStatus.Approved;
        } else {
            review.status = ProjectStatus.Rejected;
        }

        emit ReviewFinalized(projectId, review.status);
    }

    function donate() external payable {
        require(msg.value > 0, "Donation must be greater than zero");

        donations[msg.sender] += msg.value;
        unallocatedByDonor[msg.sender] += msg.value;
        unallocatedDonations += msg.value;
        totalDonations += msg.value;

        emit Donated(msg.sender, msg.value);
    }

    function refundUnallocatedDonation() external {
        uint256 amount = unallocatedByDonor[msg.sender];
        require(amount != 0, "No unallocated donation to refund");

        unallocatedByDonor[msg.sender] = 0;
        unallocatedDonations -= amount;
        donations[msg.sender] -= amount;
        totalDonations -= amount;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Donation refund failed");

        emit UnallocatedDonationRefunded(msg.sender, amount);
    }

    function donateToProject(uint256 projectId) external payable {
        require(projectId > 0 && projectId <= projectCount, "Invalid project");
        require(msg.value > 0, "Donation must be greater than zero");

        projectDonations[projectId][msg.sender] += msg.value;
        projectBalances[projectId] += msg.value;
        donations[msg.sender] += msg.value;
        totalDonations += msg.value;

        emit Donated(msg.sender, msg.value);
        emit ProjectDonation(projectId, msg.sender, msg.value);
    }

    function refundProjectDonation(uint256 projectId) external {
        require(projectId > 0 && projectId <= projectCount, "Invalid project");

        ProjectStatus status = reviews[projectId].status;
        require(
            status == ProjectStatus.Rejected || status == ProjectStatus.Expired,
            "Project not refundable"
        );

        uint256 amount = projectDonations[projectId][msg.sender];
        require(amount != 0, "No donation to refund");

        projectDonations[projectId][msg.sender] = 0;
        projectBalances[projectId] -= amount;
        donations[msg.sender] -= amount;
        totalDonations -= amount;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Donation refund failed");

        emit ProjectRefunded(projectId, msg.sender, amount);
    }
}