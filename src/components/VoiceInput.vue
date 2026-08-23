<script setup>
// 语音输入按钮：点击开始听，识别结果通过 result 事件抛出
import { ref, onBeforeUnmount } from 'vue';
import { isSpeechSupported, startSpeech } from '../utils/speech.js';

const emit = defineEmits(['result']);
const supported = isSpeechSupported();
const listening = ref(false);
let rec = null;

function toggle() {
  if (listening.value) { rec?.stop(); return; }
  listening.value = true;
  rec = startSpeech((text) => { emit('result', text); listening.value = false; }, () => { listening.value = false; });
  if (!rec) listening.value = false;
}
onBeforeUnmount(() => { rec?.stop(); });
</script>

<template>
  <button v-if="supported" class="btn small" :class="{ primary: listening }" @click="toggle" :title="listening ? '正在聆听，再点一次结束' : '语音输入'">
    {{ listening ? '聆听中…' : '语音' }}
  </button>
</template>