import { useEffect, useState } from 'react'
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  formatUnits,
  isHexString,
  keccak256,
  parseUnits,
  randomBytes,
  type Eip1193Provider,
} from 'ethers'

const RPC_URL = 'http://127.0.0.1:8545'
const REVIEW_ADDRESS = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
const TOKEN_ADDRESS = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9'
const EXPECTED_CHAIN_ID = 31337n
const MAX_DISPLAYED = 20n
const ZERO_HASH = `0x${'0'.repeat(64)}`

const REVIEW_ABI = [
  'function applicationCount() view returns (uint256)',
  'function token() view returns (address)',
  'function quote(uint256 target) view returns (uint256 deposit, uint256 verifierCount)',
  'function applications(uint256) view returns (address applicant, bytes32 metadataHash, uint256 target, uint256 deposit, uint256 verifierCount, uint256 requestId, uint256 deadline, uint256 approvals, uint256 rejections, uint8 status)',
  'function isCandidate(address) view returns (bool)',
  'function registerCandidate()',
  'function submit(uint256 target, bytes32 metadataHash) returns (uint256 applicationId)',
]

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]

const STATUS_LABELS = [
  '不存在',
  '等待奖励出资',
  '等待随机数',
  '投票中',
  '已通过（最终结论）',
  '已驳回（最终结论）',
  '结论未定（最终结论）',
  '已超时',
]

type ApplicationInfo = {
  id: string
  applicant: string
  target: string
  deposit: string
  verifierCount: string
  approvals: string
  rejections: string
  deadline: string
  status: string
}

type ChainInfo = {
  applicationCount: string
  deposit: string
  verifierCount: string
  applications: ApplicationInfo[]
}

type WalletInfo = {
  address: string
  balance: string
  candidate: boolean
}

function messageOf(cause: unknown): string {
  if (cause && typeof cause === 'object') {
    const error = cause as { shortMessage?: string; reason?: string; message?: string }
    return error.reason ?? error.shortMessage ?? error.message ?? String(cause)
  }
  return String(cause)
}

function injectedProvider(): Eip1193Provider {
  const ethereum = (window as Window & { ethereum?: Eip1193Provider }).ethereum
  if (!ethereum) throw new Error('未检测到 MetaMask。请安装钱包并打开本地 Hardhat 网络。')
  return ethereum
}

function parseTarget(value: string): bigint {
  const input = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input)) {
    throw new Error('请输入有效的慈善币目标金额，最多 18 位小数。')
  }
  const target = parseUnits(input, 18)
  if (target <= 0n) throw new Error('目标金额必须大于 0。')
  return target
}

async function checkedWallet() {
  const provider = new BrowserProvider(injectedProvider())
  const network = await provider.getNetwork()
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`MetaMask 网络错误：请切换至 Hardhat 本地链（31337），当前为 ${network.chainId}。`)
  }
  if (
    (await provider.getCode(REVIEW_ADDRESS)) === '0x' ||
    (await provider.getCode(TOKEN_ADDRESS)) === '0x'
  ) {
    throw new Error('钱包连接的链上找不到演示合约。请确认 MetaMask RPC 为 http://127.0.0.1:8545，并重新部署。')
  }
  const signer = await provider.getSigner()
  const review = new Contract(REVIEW_ADDRESS, REVIEW_ABI, signer)
  const actualToken = await review.token() as string
  if (actualToken.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) {
    throw new Error(`审核合约使用的代币地址为 ${actualToken}，与前端配置不符。`)
  }
  const token = new Contract(TOKEN_ADDRESS, TOKEN_ABI, signer)
  return { signer, review, token }
}

function App() {
  const [info, setInfo] = useState<ChainInfo | null>(null)
  const [wallet, setWallet] = useState<WalletInfo | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState('50000')
  const [metadataHash, setMetadataHash] = useState('')

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      const provider = new JsonRpcProvider(RPC_URL)
      const network = await provider.getNetwork()
      if (network.chainId !== EXPECTED_CHAIN_ID) {
        throw new Error(`链 ID 不符：期望 31337，实际 ${network.chainId}`)
      }
      if ((await provider.getCode(REVIEW_ADDRESS)) === '0x') {
        throw new Error('该地址没有合约。节点可能已重启，请重新部署。')
      }

      const review = new Contract(REVIEW_ADDRESS, REVIEW_ABI, provider)
      const actualToken = await review.token() as string
      if (actualToken.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) {
        throw new Error(`审核合约的代币地址为 ${actualToken}，与前端配置不符。`)
      }
      const [count, quote] = await Promise.all([
        review.applicationCount() as Promise<bigint>,
        review.quote(parseUnits('50000', 18)),
      ])

      const firstId = count > MAX_DISPLAYED ? count - MAX_DISPLAYED + 1n : 1n
      const ids: bigint[] = []
      for (let id = count; id >= firstId; id--) ids.push(id)

      const entries = await Promise.all(
        ids.map(async (id): Promise<ApplicationInfo> => {
          const application = await review.applications(id)
          const statusNumber = Number(application.status)
          const deadline = application.deadline as bigint
          return {
            id: id.toString(),
            applicant: application.applicant as string,
            target: formatUnits(application.target as bigint, 18),
            deposit: formatUnits(application.deposit as bigint, 18),
            verifierCount: application.verifierCount.toString(),
            approvals: application.approvals.toString(),
            rejections: application.rejections.toString(),
            deadline: deadline === 0n
              ? '尚未开始投票'
              : new Date(Number(deadline) * 1000).toLocaleString('zh-CN'),
            status: STATUS_LABELS[statusNumber] ?? `未知状态（${statusNumber}）`,
          }
        }),
      )

      setInfo({
        applicationCount: count.toString(),
        deposit: formatUnits(quote[0], 18),
        verifierCount: quote[1].toString(),
        applications: entries,
      })
    } catch (cause) {
      setInfo(null)
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }

  async function updateWallet() {
    const { signer, review, token } = await checkedWallet()
    const address = await signer.getAddress()
    const [balance, candidate] = await Promise.all([
      token.balanceOf(address) as Promise<bigint>,
      review.isCandidate(address) as Promise<boolean>,
    ])
    setWallet({ address, balance: formatUnits(balance, 18), candidate })
    return { address, review, token }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  async function connect() {
    await run(async () => {
      await injectedProvider().request({ method: 'eth_requestAccounts' })
      await updateWallet()
      setNotice('钱包已连接。')
    })
  }

  async function mintDemoToken() {
    await run(async () => {
      const { address, token } = await updateWallet()
      setNotice('等待确认领取本地测试币的交易…')
      const tx = await token.mint(address, parseUnits('1000', 18))
      await tx.wait()
      await updateWallet()
      setNotice('已领取 1000 枚本地模拟代币；它没有真实价值。')
    })
  }

  async function register() {
    await run(async () => {
      const { review } = await updateWallet()
      setNotice('等待确认公证员候选人注册交易…')
      const tx = await review.registerCandidate()
      await tx.wait()
      await updateWallet()
      setNotice('已注册候选公证员。申请人本人不会进入自己申请的候选名单。')
    })
  }

  async function submit() {
    await run(async () => {
      const requested = parseTarget(target)
      const hash = metadataHash.trim()
      if (!isHexString(hash, 32) || hash.toLowerCase() === ZERO_HASH) {
        throw new Error('请输入非零的 32 字节元数据哈希（0x 开头，共 66 个字符）。不要上传真实医疗资料。')
      }

      const { address, review, token } = await updateWallet()
      const quote = await review.quote(requested)
      const deposit = quote[0] as bigint
      const verifierCount = quote[1] as bigint
      const balance = await token.balanceOf(address) as bigint
      if (balance < deposit) {
        throw new Error(`余额不足：需要 ${formatUnits(deposit, 18)} 枚测试币，请先领取。`)
      }

      setNotice(`目标需要 ${formatUnits(deposit, 18)} 枚押金、${verifierCount} 名公证员；正在检查授权…`)
      const allowance = await token.allowance(address, REVIEW_ADDRESS) as bigint
      if (allowance < deposit) {
        const tx = await token.approve(REVIEW_ADDRESS, deposit)
        setNotice('等待押金授权交易确认…')
        await tx.wait()
      }

      // 模拟调用可提前发现“候选人不足”等合约条件，但不保证正式交易一定成功。
      setNotice('正在检查申请条件…')
      await review.submit.staticCall(requested, hash)
      const tx = await review.submit(requested, hash)
      setNotice('申请交易已发送，等待链上确认…')
      await tx.wait()
      await Promise.all([refresh(), updateWallet()])
      setNotice('申请已提交。注意：这只创建审核申请，不会自动募集目标金额。')
    })
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <main style={{ maxWidth: 720, margin: '64px auto', padding: 24 }}>
      <h1>CharityTrace</h1>
      <p>慈善申请审核系统 · Hardhat 本地演示原型</p>
      <p><strong>仅使用模拟代币；不处理真实捐款或医疗资料。</strong></p>
      <p>RPC：<code>{RPC_URL}</code></p>
      <p>审核合约：<code>{REVIEW_ADDRESS}</code></p>

      {loading && <p>正在读取链上数据…</p>}
      {error && <p role="alert" style={{ color: 'crimson' }}>操作失败：{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <section>
        <h2>1. 连接钱包与测试准备</h2>
        <p>MetaMask 应连接到本机 RPC，Chain ID 为 31337。</p>
        <button type="button" onClick={() => void connect()} disabled={busy}>
          {wallet ? '重新连接／更新钱包' : '连接 MetaMask'}
        </button>
        {wallet && (
          <>
            <p>账户：<code>{wallet.address}</code></p>
            <p>测试币余额：{wallet.balance} TEST</p>
            <p>候选公证员：{wallet.candidate ? '已注册' : '未注册'}</p>
            <button type="button" onClick={() => void mintDemoToken()} disabled={busy}>
              领取 1000 测试币
            </button>{' '}
            <button
              type="button"
              onClick={() => void register()}
              disabled={busy || wallet.candidate}
            >
              注册候选公证员
            </button>
          </>
        )}
        <p>演示代币的领取函数没有权限控制，<strong>仅限本地测试</strong>。</p>
      </section>

      <section>
        <h2>2. 提交申请</h2>
        <p>
          提交前需由<strong>至少 10 个不同的其他钱包地址</strong>完成候选人注册；
          目标超过 5 万币时，需要更多候选人。
        </p>
        <label>
          申请目标（TEST）：
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            disabled={busy}
            style={{ display: 'block', width: '100%', margin: '8px 0 16px' }}
          />
        </label>
        <label>
          元数据哈希（bytes32）：
          <input
            value={metadataHash}
            onChange={(event) => setMetadataHash(event.target.value)}
            placeholder="0x 后接 64 位十六进制字符"
            disabled={busy}
            style={{ display: 'block', width: '100%', margin: '8px 0' }}
          />
        </label>
        <button
          type="button"
          onClick={() => setMetadataHash(keccak256(randomBytes(32)))}
          disabled={busy}
        >
          生成演示用随机哈希
        </button>
        <p>随机哈希只是占位值，<strong>不代表证明材料已核验</strong>。不要将真实医疗资料写入链上。</p>
        <button type="button" onClick={() => void submit()} disabled={busy || !wallet}>
          授权押金并提交申请
        </button>
      </section>

      <section>
        <h2>本地链数据</h2>
        {info && (
          <>
            <ul>
              <li>申请总数：{info.applicationCount}</li>
              <li>5 万币目标所需押金：{info.deposit} TEST</li>
              <li>对应公证员数量：{info.verifierCount}</li>
            </ul>
            <h3>最近的申请（最多 20 条）</h3>
            {info.applications.length === 0 ? (
              <p>暂无申请。</p>
            ) : (
              <ol>
                {info.applications.map((application) => (
                  <li key={application.id} style={{ marginBottom: 24 }}>
                    <strong>申请 #{application.id} · {application.status}</strong>
                    <div>申请人：<code>{application.applicant}</code></div>
                    <div>募捐目标：{application.target} TEST</div>
                    <div>押金：{application.deposit} TEST</div>
                    <div>公证员数量：{application.verifierCount}</div>
                    <div>赞成 / 反对：{application.approvals} / {application.rejections}</div>
                    <div>投票截止：{application.deadline}</div>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        <button type="button" onClick={() => void refresh()} disabled={loading || busy}>
          刷新链上数据
        </button>
      </section>
    </main>
  )
}

export default App