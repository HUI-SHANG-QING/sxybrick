#!/usr/bin/env node
/**
 * 提交链路体检：一眼看清「有没有没提交 / 有没有没推 / 下一步该做什么」
 *
 * 用法：node scripts/git-check.mjs   或   npm run git:check
 *
 * 说明：git push 只说「本地 commit 是否已推到远程」，它看不见
 *   ① 工作区改了文件但忘了 git commit；
 *   ② push 之后 Actions 是否部署成功、浏览器是否缓存旧版。
 * 本脚本把三态（工作区/本地仓库/远程）一次核对清楚。
 */
import { execFileSync } from 'node:child_process';

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const split = (s) => (s ? s.split('\n').map((x) => x.trimEnd()).filter(Boolean) : []);

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);

console.log('=== SxyBrick 提交链路体检 ===');
console.log('分支: ' + branch);
console.log('上游: ' + (upstream || '（未设置，首次推送请用 git push -u origin ' + branch + '）'));
console.log('');

// [1] 工作区未提交改动
const status = git(['status', '--porcelain=v1']);
const dirty = split(status);
const staged = dirty.filter((l) => l[0] !== ' ' && l[0] !== '?');
const unstaged = dirty.filter((l) => l[1] !== ' ' && l[1] !== '?');
const untracked = dirty.filter((l) => l[0] === '?' && l[1] === '?');
console.log('[1] 工作区未提交改动: ' + dirty.length + ' 个文件');
if (dirty.length) {
  console.log('    已暂存(绿, 未 commit): ' + staged.length + '  |  未暂存(红, 未 add): ' + unstaged.length + '  |  未跟踪(??): ' + untracked.length);
  for (const l of dirty.slice(0, 15)) console.log('      ' + l);
  if (dirty.length > 15) console.log('      …… 共 ' + dirty.length + ' 项');
} else {
  console.log('    OK 干净');
}
console.log('');

// [2]/[3] 本地领先 / 远程领先
let ahead = 0;
let behind = 0;
if (upstream) {
  const cnt = git(['rev-list', '--left-right', '--count', upstream + '...HEAD']);
  if (cnt) {
    const [b, a] = cnt.split(/\s+/).map(Number);
    behind = b || 0;
    ahead = a || 0;
  }
}
console.log('[2] 本地领先远程（待推送）: ' + ahead + ' 个');
if (ahead > 0 && upstream) {
  for (const l of split(git(['log', '--oneline', upstream + '..HEAD']))) console.log('    ' + l);
}
console.log('[3] 远程领先本地（需拉取）: ' + behind + ' 个');
if (behind > 0 && upstream) {
  for (const l of split(git(['log', '--oneline', 'HEAD..' + upstream]))) console.log('    ' + l);
}
console.log('');

// [4] 结论
console.log('[4] 下一步:');
if (dirty.length) {
  console.log('    未提交的改动 git push 看不到，先执行:');
  console.log('      git add -A && git commit -m "..."');
} else if (ahead > 0) {
  console.log('    执行: git push origin ' + branch);
  console.log('    推送后到 GitHub Actions 确认构建转绿，再用无痕窗口验证功能');
} else if (behind > 0) {
  console.log('    本地落后远程，先执行: git pull origin ' + branch);
} else {
  console.log('    本地与远程一致。若功能仍未更新，是部署/缓存问题:');
  console.log('      1) GitHub Actions 看最近一次构建是否绿色对勾');
  console.log('      2) 无痕窗口访问，排除浏览器 PWA 缓存旧版');
}
