import { useHealthStore } from '@/stores/health';
import { useHubStore } from '@/stores/hub';

/**
 * 健康计划每天到点自动排（健康设置里的时间，默认 04:00）：连了云端、Worker 会排时云端排（PWA 关着也排），
 * 这里只把附近的店按家搜一次留着给云端用；云端不排（没连、Worker 是旧版）时 App 开着到点就在手机上排。
 */
let started = false;

export function startHealthSchedule() {
  if (started) return;
  started = true;
  const tick = () => {
    const hub = useHubStore();
    // 云端状态还没回来时先不在手机上排，免得和云端各排一份
    const cloud = hub.connected && (hub.supportsHealth || !hub.status);
    void useHealthStore().tickSchedule(cloud);
  };
  setTimeout(tick, 30_000);
  setInterval(tick, 5 * 60_000);
}
