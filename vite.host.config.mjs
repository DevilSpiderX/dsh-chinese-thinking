import { defineConfig } from "vite";

/**
 * host 侧构建：src/index.ts -> lib/index.min.js（ESM 单文件，Node 目标）。
 *
 * 结构对齐 dsh-workspace-only-plugin 的 vite.host.config.mjs，两处按本项目契约适配：
 * - 产物是单文件 `index.min.js`（package.json 的 main/exports 指向它），不做
 *   preserveModules，用 output.entryFileNames 锁死文件名。
 * - 压缩直接用 Vite 内置 oxc minify（全量 compress + mangle），等价原来的
 *   `esbuild --minify`；不走参考项目的 stripComments 插件——本产物还带
 *   sourcemap，minify 需由打包器参与才能正确生成映射链。
 */
export default defineConfig({
    esbuild: { target: "es2022" }, // 与 tsconfig target 一致，对应原 esbuild --target=es2022。
    build: {
        outDir: "lib",
        // build 脚本里 tsc 先落盘 lib/*.d.ts，这里不能清空 outDir。
        emptyOutDir: false,
        // Node 目标：Vite 的浏览器 define 处理会把 `process.env` 替换成空对象，
        // 插件里的 CT_DEBUG / 运行时探测依赖原样的 process.env。
        ssr: true,
        minify: "oxc", // SSR 构建默认不压缩，显式开启（产物名就是 index.min.js）。
        sourcemap: true, // 对应原 esbuild --sourcemap。
        target: "es2022",
        rollupOptions: {
            input: "src/index.ts",
            external: [/^node:/, /^@deepseek-ai\//], // 运行时依赖来自 dsh 宿主，绝不打进 bundle。
            output: {
                format: "es", // 对应原 --format=esm。
                entryFileNames: "index.min.js"
            }
        }
    }
});
