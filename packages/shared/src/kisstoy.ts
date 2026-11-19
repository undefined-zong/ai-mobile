/** KISSTOY 官方分享遥控页的协议；会话和设备型号均来自分享链接。 */
export const KISSTOY_PATH = {
  device: '/kisstoy/device/detail',
  bind: '/kisstoy/remote-control/binding',
  socket: '/websocket-kisstoy',
} as const;

export type KisstoyAction = 'device' | 'bind';

export interface KisstoyShare {
  origin: string;
  id: string;
  group: string;
  deviceId: string;
  hardwareVersion: number | null;
}

export interface KisstoyMotorConfig {
  motors?: { type: number | string }[];
}

export interface KisstoyCapabilityOverride extends KisstoyMotorConfig {
  min_hardware_version?: number;
  minHardwareVersion?: number;
  max_hardware_version?: number;
  maxHardwareVersion?: number;
}

export interface KisstoyDeviceDetail {
  name: string;
  config: KisstoyMotorConfig & {
    firmwareCapabilityOverrides?: KisstoyCapabilityOverride[];
    firmware_capability_overrides?: KisstoyCapabilityOverride[];
  };
}

export function parseKisstoyShareUrl(input: string): KisstoyShare {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请粘贴 KISSTOY App 生成的完整分享遥控链接'); }
  const query = new URLSearchParams(url.search);
  const hashQuery = url.hash.indexOf('?');
  if (hashQuery >= 0) new URLSearchParams(url.hash.slice(hashQuery + 1)).forEach((v, k) => query.set(k, v));
  const id = query.get('id') ?? '';
  const group = query.get('group') ?? '';
  const deviceId = query.get('device_id') ?? '';
  if (url.protocol !== 'https:' || url.username || url.password || !id || !group || !/^\d+$/.test(deviceId) || Number(deviceId) <= 0) {
    throw new Error('分享链接不完整：请从 KISSTOY App 重新复制，保留 id、group 和 device_id');
  }
  const hardwareVersion = Number(query.get('hardware_version'));
  return { origin: url.origin, id, group, deviceId, hardwareVersion: Number.isFinite(hardwareVersion) && hardwareVersion > 0 ? hardwareVersion : null };
}
