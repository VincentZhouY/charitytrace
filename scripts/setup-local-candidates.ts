import { network } from "hardhat";

const REVIEW_ADDRESS = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";
const TOKEN_ADDRESS = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";

const { ethers } = await network.create({
  network: "localhost",
  chainType: "l1",
});

const chain = await ethers.provider.getNetwork();
if (chain.chainId !== 31337n) {
  throw new Error(`拒绝操作：预期本地链 31337，实际为 ${chain.chainId}`);
}

if ((await ethers.provider.getCode(REVIEW_ADDRESS)) === "0x") {
  throw new Error("审核合约地址上没有代码；请检查本地节点和部署地址。");
}

const readReview = new ethers.Contract(
  REVIEW_ADDRESS,
  [
    "function token() view returns (address)",
    "function isCandidate(address) view returns (bool)",
  ],
  ethers.provider,
);

const actualToken = (await readReview.token()) as string;
if (actualToken.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) {
  throw new Error(`代币地址不符：合约实际使用 ${actualToken}`);
}

const signers = await ethers.getSigners();
if (signers.length < 12) {
  throw new Error(`需要至少 12 个本地测试账户，目前只有 ${signers.length} 个。`);
}

// 第 0 个账户留作申请人；注册第 1～11 个账户。
for (let i = 1; i <= 11; i++) {
  const signer = signers[i];
  const address = await signer.getAddress();

  if (await readReview.isCandidate(address)) {
    console.log(`候选人 ${i}/11 已存在：${address}`);
    continue;
  }

  const review = new ethers.Contract(
    REVIEW_ADDRESS,
    ["function registerCandidate()"],
    signer,
  );
  const tx = await review.registerCandidate();
  await tx.wait();
  console.log(`候选人 ${i}/11 注册成功：${address}`);
}

console.log("完成：11 个测试账户已注册为候选公证员。");
console.log("现在可在网页尝试提交目标为 50000 TEST 的申请。");