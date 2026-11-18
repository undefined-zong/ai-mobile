/// <reference types="vite/client" />

declare module 'virtual:uno.css';

interface ImportMetaEnv {
  readonly MODE: string;
  /** 构建这份 App 的 GitHub 仓库（owner/repo，见 vite.config.ts）；不知道时为空 */
  readonly VITE_GITHUB_REPO: string;
}

/** 安卓壳注入的原生桥（M3 实现）。在浏览器/iPhone PWA 里不存在。 */
interface Window {
  AiCompanionNative?: {
    getInfo(): string;
    vibrate(pattern: string): string;
    notify(json: string): string;
    scheduleAlarms(json: string): string;
  };
}
