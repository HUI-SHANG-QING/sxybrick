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
console.log('');

if (head && head === cachedRemote) {
  console.log('✓ 本地与上次 fetch 的远端一致（很可能已全部推送）');
  process.exit(0);
}

console.log('✗ 本地 HEAD 与缓存的 origin/main 不同 ⇒ **存在未推送的提交**');
console.log('');
console.log('查看清单： git log --oneline ' + cachedRemote.slice(0, 7) + '..HEAD');
console.log('推送：     git push origin main');
process.exit(1);