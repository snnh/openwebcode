// ESLint flat config — 规则类检查基线（不引入 Prettier，不做风格重排）。
// 基线：eslint recommended + typescript-eslint recommended（非 type-checked 档，
// 避免类型感知规则拖慢 CI），另加 react-hooks 两条核心规则与 eqeqeq。
import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist/ 为 vite 产物；coverage/ 为测试覆盖率产物
    ignores: ["dist/", "node_modules/", "coverage/", "public/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node 侧脚本（vite.config / 构建脚本）需要 node 全局，否则 no-undef 误报
    files: ["*.config.{js,ts}", "scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // exhaustive-deps 降级为 warn：存量代码大量刻意省略依赖（流式订阅场景），
      // 逐个修复需改语义，先告警不阻断，后续逐步收敛
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      // null 用松散比较：value != null 同时兜住 null/undefined，是刻意的空值合并判断
      eqeqeq: ["error", "always", { null: "ignore" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
