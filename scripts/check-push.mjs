// scripts/check-push.mjs —— 推送状态自检（round143）
//
// 为什么需要它：连续多轮我在回复里写「代码还没推上去，网络时好时坏」，
// 但**从来没有验证过这句话** —— 只是「git push 失败了 ⇒ 推断没推上去」。
// push 失败有多种原因（网络 / 认证 / 远端已有新提交），真正要回答的是：
//   **本地 HEAD 相对远端 main 到底领先几个提交、那些提交是什么。**
//
// ⚠️ 本机 Node 启动**任何**子进程都可能 EBUSY（文件锁；记忆里 C 盘满引发的连锁反应），
//   连 `sh -c` 也会失败 ⇒ **本脚本刻意零子进程**，全部靠「读 .git 目录里的文件」。
//   代价：拿不到远端**实时** SHA，只能对比本地缓存的 origin/main —— 故输出里
//   明确标注这一点，不把缓存当成事实。
//
// 用法：node scripts/check-push.mjs
//   退出码 0 = 与上次 fetch 的远端一致；1 = 存在未推送提交；2 = 无 origin/main 记录
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GIT_DIR = join(process.cwd(), '.git');

function readRef(rel) {
  const p = join(GIT_DIR, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim() || null;
}

function resolveHead() {
  const raw = readRef('HEAD');
  if (!raw) return null;
  if (raw.startsWith('ref: ')) {
    const ref = raw.slice(5).trim();
    return readRef(ref) || ref;            // 分离头 ⇒ 只能给出 ref 名
  }
  return raw;
}

const head = resolveHead();
console.log('本地 HEAD  : ' + (head || '(未知)'));
console.log('');

const cachedRemote = readRef('refs/remotes/origin/main');
if (!cachedRemote) {
  console.log('⚠️ 本地**没有** origin/main 的任何记录（可能从未成功 fetch 过）');
  console.log('   ⇒ 无从判断是否已推送。网络恢复后先执行：git fetch origin');
  process.exit(2);
}

console.log('缓存 origin/main: ' + cachedRemote);
const fh = join(GIT_DIR, 'FETCH_HEAD');
if (existsSync(fh)) {
  const first = readFileSync(fh, 'utf8').split('\n')[0].trim();
  if (first) console.log('  上次 fetch: ' + first.slice(0, 90));
}
console.log('  ⚠️ 这是**上次成功 fetch 时**的快照，真实远端可能已变化');
console.log('    （本脚本零子进程，无法实时查询远端）');

// ── 工作区是否干净（round144 补）──
// 推送前**必须**知道工作区状态：脏工作区意味着本地有还没纳入版本管理的改动
//（新文件 / 未提交修改），此时 push 推上去的是**上一次提交时的代码**，不是"我眼前这份"。
// 上一版脚本完全没提这件事 —— 属于会误导决策的信息缺口。
//
// ⚠️ 本机 Node 启动子进程常 EBUSY，故**降级路径**：子进程失败时改为扫描工作区文件系统
//   ——只看最可能遗漏的两类：**未跟踪文件（src/ 下的新文件）与被改过的源码文件**。
//   这是近似判断（会在输出里标注），宁可说"不确定"也不谎称"干净"。
let dirty = null;
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('sh', ['-c', '"C:/Program Files/Git/bin/git.exe" status --porcelain'],
    { cwd: process.cwd(), encoding: 'utf8' });
  dirty = out.split('\n').filter((l) => l.trim());
} catch { dirty = null; }

if (dirty === null) {
  // ⚠️ 刻意**不**退化成"扫文件系统猜哪些没提交" —— 那只会产出噪音（几百个文件，等于没说）。
  //   宁可明说"查不到，请手动确认"，也不给一个看起来像结论的猜测。
  console.log('  工作区: ⚠️ 无法用 git 判定（本机子进程 EBUSY）——请手动执行 git status');
} else if (dirty.length === 0) {
  console.log('  工作区: ✓ 干净');
} else {
  console.log(`  工作区: ⚠️ **有 ${dirty.length} 项未提交变更**（推送上去的是上一次提交时的代码）`);
  for (const l of dirty.slice(0, 5)) console.log('     ' + l);
  if (dirty.length > 5) console.log(`     …另 ${dirty.length - 5} 项`);
}
console.log('');

if (head && head === cachedRemote) {
  console.log('✓ 本地与上次 fetch 的远端一致（很可能已全部推送）');
  process.exit(0);
}

console.log('✗ 本地 HEAD 与缓存的 origin/main 不同 ⇒ **存在未推送的提交**');
console.log('');
// ⚠️ 零子进程 ⇒ **算不出「领先几个提交」**（需 git rev-list 遍历提交图）。
//   这是本脚本已知的取舍：宁可少报一项，也不能给一个编造的数字。
//   要精确数量请用下面两条命令（网络恢复时可用）。
console.log('⚠️ 本脚本零子进程，无法计算「领先几个提交」——这是刻意取舍，不编造数字。');
console.log('');
console.log('  精确清单与数量： git log --oneline ' + cachedRemote.slice(0, 7) + '..HEAD');
console.log('                  git rev-list --count ' + cachedRemote.slice(0, 7) + '..HEAD');
console.log('  推送：           git push origin main');
process.exit(1);