import { execSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { VantResolver } from '@vant/auto-import-resolver';
import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import Components from 'unplugin-vue-components/vite';
import { defineConfig, type PluginOption } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 这份 App 是从哪个 GitHub 仓库构建的（owner/repo）：一起观影的 B 站片单在这个仓库的 bilibili-data 分支上，
 * fork 过去的仓库用自己的。依次看 VITE_GITHUB_REPO（自己指定）、GitHub Actions 给的 GITHUB_REPOSITORY、本地的 git remote origin。
 */
function githubRepo(): string {
  const set = process.env.VITE_GITHUB_REPO || process.env.GITHUB_REPOSITORY;
  if (set) return set;
  try {
    const url = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * mode = preview：给 Claude Artifact 预览用的单文件构建（内存路由 + 所有资源内联）。
 * 其余 mode：正式 PWA / APK 资源（hash 路由，多文件）。
 */
export default defineConfig(({ mode }) => {
  const isPreview = mode === 'preview';
  const plugins: PluginOption[] = [
    // KaTeX 的字体只要 woff2（App 支持的浏览器都认）：不打包 woff / ttf，单文件预览页也小一圈
    {
      name: 'katex-woff2-only',
      enforce: 'pre',
      transform(code, id) {
        if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id.split('?')[0]!)) return null;
        return code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/g, '');
      },
    },
    vue(),
    UnoCSS(),
    // 只自动引入 Vant 组件；自己的组件一律显式 import，读代码时一眼能找到来源
    Components({ resolvers: [VantResolver()], dirs: [], dts: 'src/components.d.ts' }),
  ];
  if (isPreview) plugins.push(viteSingleFile({ removeViteModuleLoader: true }));

  return {
    base: './',
    define: { 'import.meta.env.VITE_GITHUB_REPO': JSON.stringify(githubRepo()) },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    plugins,
    build: {
      outDir: isPreview ? 'dist-preview' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      chunkSizeWarningLimit: 2000,
    },
    server: { host: true, port: 5173 },
  };
});
