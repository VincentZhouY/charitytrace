import { network } from "hardhat";

const { ethers } = await network.create({
  network: "localhost",
  chainType: "l1",
});

const chain = await ethers.provider.getNetwork();
if (chain.chainId !== 31337n) {
  throw new Error(`拒绝部署：预期本地链 31337，实际为 ${chain.chainId}`);
}

const [deployer] = await ethers.getSigners();
console.log("部署账户:", deployer.address);

const token = await ethers.deployContract("MockCharityToken");
await token.waitForDeployment();
const tokenAddress = await token.getAddress();
console.log("模拟代币:", tokenAddress);

const provider = await ethers.deployContract("MockRandomnessProvider");
await provider.waitForDeployment();
const providerAddress = await provider.getAddress();
console.log("模拟随机数提供者:", providerAddress);

const review = await ethers.deployContract("AidApplicationReview", [
  tokenAddress,
  providerAddress,
]);
await review.waitForDeployment();
console.log("申请审核合约:", await review.getAddress());