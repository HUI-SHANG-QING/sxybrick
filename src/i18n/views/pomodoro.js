// src/i18n/views/pomodoro.js
// 番茄钟视图（Pomodoro.vue）的 zh/en 字典片段。
export const zh = {
  title: '番茄钟',
  hint: '25 分钟专注 + 5 分钟休息，每 4 轮一个长休息。到点自动语音提醒。',
  modeFocus: '专注 25′',
  modeShort: '短休 5′',
  modeLong: '长休 15′',
  labelFocus: '专注',
  labelShort: '短休息',
  labelLong: '长休息',
  start: '开始',
  pause: '暂停',
  reset: '重置',
  doneToday: '今日已完成 {n} 个番茄钟',
  focusDone: '专注完成，休息一下！',
  focusDoneSpeech: '专注完成，休息一下吧',
  // round18 R18-6：未跑满一个完整番茄时如实告知（此前「到点即满记」，中断也记 25 分钟）
  focusPartial: '本轮只专注了 {min} 分钟，未计为完整番茄（已按实际时长记录）',
  restDone: '休息结束，继续加油！',
  restDoneSpeech: '休息结束，继续加油',
  notifyTitle: '番茄钟完成',
  notifyMsg: '专注 25 分钟结束，休息一下吧！',
};

export const en = {
  title: 'Pomodoro',
  hint: '25-min focus + 5-min break, with a long break every 4 rounds. Voice reminder at the end.',
  modeFocus: 'Focus 25′',
  modeShort: 'Short 5′',
  modeLong: 'Long 15′',
  labelFocus: 'Focus',
  labelShort: 'Short break',
  labelLong: 'Long break',
  start: 'Start',
  pause: 'Pause',
  reset: 'Reset',
  doneToday: '{n} pomodoros completed today',
  focusDone: 'Focus done — take a break!',
  focusDoneSpeech: 'Focus complete, take a break',
  // round18 R18-6: report the honest net focus time when a round did not run its full length
  focusPartial: 'Only {min} min of actual focus this round — not counted as a full pomodoro (actual time was recorded)',
  restDone: 'Break over — keep going!',
  restDoneSpeech: 'Break over, keep going',
  notifyTitle: 'Pomodoro complete',
  notifyMsg: 'The 25-minute focus session is over — take a break!',
};
