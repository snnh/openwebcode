// ESLint flat config — 规则类检查基线（不引入 Prettier，不做风格重排）。
// 基线：eslint recommended + typescript-eslint recommended（非 type-checked 档，
// 避免类型感知规则拖慢 CI），另加 eqeqeq 与 unused-vars 的 `_` 前缀豁免。
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist/ 为 tsc 产物（含生成的 config/）；coverage/ 为测试覆盖率产物
    ignores: ["dist/", "node_modules/", "coverage/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node 侧脚本（MCP fixture 等 .mjs）需要 node 全局，否则 no-undef 误报
    files: ["test/fixtures/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // 桩 provider 常用“只抛错不产出”的 async generator，yield 缺失是刻意的
      "require-yield": "off",
      // 测试里用空循环体排空流（for await (...) {}）是惯用法，不加注释凑数
      "no-empty": "off",
    },
  },
  {
    rules: {
      eqeqeq: ["error", "always"],
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
