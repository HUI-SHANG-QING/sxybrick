// .eslintrc.cjs —— 基础代码规范（P1-19）
// 设计：以 eslint:recommended 兜住「明显错误」(未定义变量/重复声明/无谓赋值等)，
// 再用 eslint-plugin-vue 覆盖 <template> 与 <script setup>，最后 prettier 收尾格式。
// 刻意不开启 stylistic 重规则，避免对既有 3.5 万行代码产生海量噪音；目标是「不新增 error 级问题」。
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-recommended',
    'prettier',
  ],
  plugins: ['vue'],
  globals: {
    IndexedDB: 'readonly',
    pdfjsLib: 'readonly',
    Tesseract: 'readonly',
    self: 'readonly',
    dynamicsCompat: 'readonly',
  },
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'off',
    'vue/multi-word-component-names': 'off',
    'vue/no-mutating-props': 'warn',
    'vue/require-default-prop': 'off',
    'vue/no-unused-vars': 'off',
    'vue/attributes-order': 'off',
    'vue/order-in-components': 'off',
  },
  ignorePatterns: ['dist', 'dev-dist', 'node_modules', 'tests', 'scripts', 'sync-hub'],
};
