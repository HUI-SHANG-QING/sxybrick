// src/agent/blackboard.js
// 共享黑板：多智能体协作的「公共工作区」。
// 设计灵感：Blackboard Pattern（黑板架构）——多个 Agent 围绕一块共享黑板，
// 各自把发现/产出写到黑板上，其他 Agent 可以读取并在此基础上继续工作。
//
// 核心能力：
//   1) findings：各 Agent 的发现/结论（追加式，带来源与时间）
//   2) artifacts：结构化产出（卡片候选/计划/分析报告等，按 key 覆盖）
//   3) messages：Agent 间定向消息（A→B 委托/请求）
//   4) task：原始问题 + 分解后的子任务列表
//   5) 摘要：把黑板内容压缩成可注入 prompt 的文本

import { uid } from '../db.js';

export class Blackboard {
  constructor(query = '') {
    this.id = uid();
    this.query = query;
    this.createdAt = Date.now();
    this.findings = [];      // { id, agent, text, ts }
    this.artifacts = {};      // { key: { value, agent, ts } }
    this.messages = [];       // { id, from, to, text, ts, read }
    this.subtasks = [];       // { id, agent, description, status, result }
    this.status = 'running';  // running | done | failed
    this.agentLog = [];       // { agent, action, ts }
  }

  /** 追加一条发现 */
  addFinding(agent, text) {
    const f = { id: uid(), agent, text: String(text || ''), ts: Date.now() };
    this.findings.push(f);
    return f.id;
  }

  /** 写入/覆盖一个结构化产出 */
  setArtifact(key, value, agent) {
    this.artifacts[key] = { value, agent, ts: Date.now() };
  }

  /** 读取一个产出 */
  getArtifact(key) {
    return this.artifacts[key]?.value ?? null;
  }

  /** 发送 Agent 间消息 */
  sendMessage(from, to, text) {
    const m = { id: uid(), from, to, text: String(text || ''), ts: Date.now(), read: false };
    this.messages.push(m);
    return m.id;
  }

  /** 读取发给某 Agent 的未读消息 */
  readMessages(to) {
    const unread = this.messages.filter((m) => m.to === to && !m.read);
    for (const m of unread) m.read = true;
    return unread;
  }

  /** 添加子任务 */
  addSubtask(agent, description) {
    const t = { id: uid(), agent, description, status: 'pending', result: null };
    this.subtasks.push(t);
    return t.id;
  }

  /** 标记子任务完成 */
  completeSubtask(id, result) {
    const t = this.subtasks.find((s) => s.id === id);
    if (t) {
      t.status = 'done';
      t.result = result;
    }
  }

  /** 记录 Agent 操作日志 */
  log(agent, action) {
    this.agentLog.push({ agent, action, ts: Date.now() });
  }

  /** 还有未完成的子任务？ */
  hasPending() {
    return this.subtasks.some((s) => s.status === 'pending');
  }

  /** 把黑板内容压缩成可注入 prompt 的摘要文本 */
  toContextText() {
    const L = [];
    if (this.query) L.push(`原始任务：${this.query}`);
    if (this.findings.length) {
      L.push('已有发现：');
      for (const f of this.findings.slice(-8)) {
        L.push(`  [${f.agent}] ${f.text.slice(0, 200)}`);
      }
    }
    if (Object.keys(this.artifacts).length) {
      L.push('已有产出：');
      for (const [key, a] of Object.entries(this.artifacts)) {
        const preview = typeof a.value === 'string' ? a.value.slice(0, 150) : JSON.stringify(a.value).slice(0, 150);
        L.push(`  ${key}（by ${a.agent}）：${preview}`);
      }
    }
    const pending = this.subtasks.filter((s) => s.status === 'pending');
    if (pending.length) {
      L.push('待执行子任务：');
      for (const s of pending) L.push(`  [${s.agent}] ${s.description}`);
    }
    return L.join('\n');
  }

  /** 标记完成 */
  done() {
    this.status = 'done';
  }
}

/** 工厂：创建一块黑板 */
export function createBlackboard(query) {
  return new Blackboard(query);
}
