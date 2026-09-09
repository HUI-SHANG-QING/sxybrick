// ESLint 扁平配置（flat config）
//
// 迁移背景：项目装的是 ESLint 9.x，而配置一直是旧格式 .eslintrc.cjs，
// 且 npm script 传了 9.x 已移除的 `--ignore-path` / `--ext`。
// 结果：`npm run lint` 一执行就报错退出，这条门禁长期处于失效状态——
// 「未定义变量 / 重复声明」这类会造成运行时崩溃的问题完全拦不住
// （实例：round31 给 computeCalibration 加了 DEFAULT_WEIGHTS 默认参数却漏了 import，
//  一路提交进主分支，直到跑测试才以 ReferenceError 暴露；本轮 lint 复活后又抓出
//  genDeck 漏导入 decideType/scoreCard、classify-lib now() 未定义等多处同类炸弹）。
//
// 本文件按 ESLint 9 扁平格式重写，规则集与旧 .eslintrc.cjs 对齐：
//   eslint:recommended（明显错误）+ eslint-plugin-vue 的 vue3-recommended + prettier 收尾。
// 刻意不开 stylistic 重规则，避免对既有代码产生海量噪音；目标是「零 error 级问题」。

import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// 浏览器 File System Access API / 剪贴板等较新标准全局（globals 包可能未收录或滞后），
// 代码里用 `typeof X !== 'undefined'` 做了运行时守卫，此处只是让 lint 认识它们。
const WEB_PLATFORM_GLOBALS = {
  FileSystemFileHandle: 'readonly',
  FileSystemDirectoryHandle: 'readonly',
  FileSystemSyncAccessHandle: 'readonly',
  FileSystemWritableFileStream: 'readonly',
  showOpenFilePicker: 'readonly',
  showSaveFilePicker: 'readonly',
  indexedDB: 'readonly',
};

export default [
  // 忽略目录（旧配置 ignorePatterns + 构建/第三方产物）
  {
    ignores: [
      'dist/**',
      // dist_bak_* —— 本地构建留下的历史产物目录（沙箱里 vite 清空 dist 会失败，
      // 只能把旧 dist 改名备份，于是根目录堆积了多个）。必须一并忽略，
      // 否则 lint 会把打包后的压缩代码当成源码扫出上万条噪音。
      'dist*/**',
      'dev-dist/**',
      'node_modules/**',
      'tests/**',
      'scripts/**',
      'sync-hub/**',
      // 第三方/vendored 产物：tesseract emscripten 生成物（无插件意义，海量误报）
      'public/**',
      // 开发草稿/实验目录（不进构建产物）
      'experiments/**',
      '**/*.min.js',
    ],
  },

  js.configs.recommended,
  // eslint-plugin-vue 的 flat 版 vue3-recommended（等价于旧配置的 plugin:vue/vue3-recommended）
  ...pluginVue.configs['flat/recommended'],

  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest', // import attributes（`with { type: 'json' }`）需 ≥ ES2025
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        ...WEB_PLATFORM_GLOBALS,
        // 项目特有运行时全局
        IndexedDB: 'readonly',
        pdfjsLib: 'readonly',
        Tesseract: 'readonly',
        self: 'readonly',
        dynamicsCompat: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      // catch {} 空块：代码库大量「容错即忽略」写法（降级路径），属有意为之。
      // 允许空 catch，其余空块仍报错，防止 if/while 等真·空块悄悄溜走。
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // .vue：script setup 里被模板使用的变量，eslint-plugin-vue 的 vue/no-unused-vars 才懂
  // （它分析模板引用）。base no-unused-vars 看不到模板 → 大量误报，这里关掉 base 版、
  // 启用 vue 版（warn 级别，保留真实死代码提示）。
  {
    files: ['**/*.vue'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        ...WEB_PLATFORM_GLOBALS,
        IndexedDB: 'readonly',
        pdfjsLib: 'readonly',
        Tesseract: 'readonly',
        self: 'readonly',
        dynamicsCompat: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      // vue/no-unused-vars 能识别模板里的引用，base 版不行（已关）
      'vue/no-unused-vars': 'warn',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'vue/multi-word-component-names': 'off',
      'vue/no-mutating-props': 'warn',
      'vue/require-default-prop': 'off',
      'vue/attributes-order': 'off',
      'vue/order-in-components': 'off',
      // vue/no-template-shadow：代码库大量 v-for 以 `t` 作迭代变量（遮蔽 i18n 翻译器 t()）。
      // Vue 的 v-for 是元素级作用域：只要循环体内不调用 t('…') 就不会运行时碰撞（若调用，
      // 今天就会以 TypeError 暴露）——属于「潜在混淆」而非「运行时缺陷」。全局关停以免
      // 永久告警噪音；新增代码仍应避免遮蔽。
      'vue/no-template-shadow': 'off',
      // vue/no-v-html：9 处存量 v-html 已逐一审计——MarkdownRenderer→sanitizeHtml、
      // Cards/Search 高亮→search-service.highlight 先转义、WordBook→escHtml、
      // LibraryFiles 表格/文档预览→sanitizeHtml（2026-09-09 XSS 审计全绿）。
      // 保留该规则的告警只会在审计过的出口反复刷屏，故显式关停；新增 v-html
      // 一律要求先经 sanitizeHtml/escHtml，靠 code review 把关。
      'vue/no-v-html': 'off',
      // 与既有代码风格冲突的样式规则关停（lint 目标是防 error，不搞格式大清洗）
      'vue/first-attribute-linebreak': 'off',
      'vue/attribute-hyphenation': 'off',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
    },
  },

  // prettier 必须放最后：关掉所有与格式化冲突的规则
  prettier,
];
