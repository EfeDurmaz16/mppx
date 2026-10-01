// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface Token {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

// Feasibility experiment, not production subscription code.
// Deployment by payer authorizes immutable terms; no MPP credentials are parsed.
contract SplitProof {
    Token public immutable token;
    address public immutable payer;
    address public immutable creator;
    address public immutable platform;
    uint256 public immutable startsAt;
    uint256 public immutable expiresAt;
    uint256 public immutable cadence;
    bool public cancelled;
    mapping(uint256 => bool) public paid;
    error Terms();
    error Inactive();
    error AlreadyPaid();
    error CreditMismatch(address recipient, uint256 expected, uint256 actual);

    constructor(Token t, address c, address p, uint256 period, uint256 lifetime) {
        require(c != p && c != msg.sender && p != msg.sender && period > 0);
        token = t;
        payer = msg.sender;
        creator = c;
        platform = p;
        startsAt = block.timestamp;
        expiresAt = block.timestamp + lifetime;
        cadence = period;
    }

    function cancel() external {
        require(msg.sender == payer);
        cancelled = true;
    }

    function settle(uint256 creatorAmount, uint256 platformAmount) external {
        if (creatorAmount != 8e6 || platformAmount != 2e6) revert Terms();
        if (cancelled || block.timestamp >= expiresAt) revert Inactive();
        uint256 period = (block.timestamp - startsAt) / cadence;
        if (paid[period]) revert AlreadyPaid();
        paid[period] = true;
        pay(creator, creatorAmount);
        pay(platform, platformAmount);
    }

    function pay(address recipient, uint256 amount) internal virtual {
        uint256 beforeBalance = token.balanceOf(recipient);
        require(token.transferFrom(payer, recipient, amount));
        uint256 credited = token.balanceOf(recipient) - beforeBalance;
        if (credited != amount) revert CreditMismatch(recipient, amount, credited);
    }
}

// Deliberately unsafe control: transaction success is mistaken for delivery.
contract UnguardedSplitProof is SplitProof {
    constructor(Token t, address c, address p, uint256 period, uint256 lifetime)
        SplitProof(t, c, p, period, lifetime) {}

    function pay(address recipient, uint256 amount) internal override {
        require(token.transferFrom(payer, recipient, amount));
    }
}
