/**
 * 多设备同步的线上格式（设计文档 §12.3）。kind 是本机库的表名（characters、moments、settings……），
 * 聊天消息按条同步：kind 是 'message'，parent 是聊天 id。data 是记录本身（JSON，永远不含 Key）；
 * 太大的记录、图片和文件按 SHA-256 存进同步用的大文件，data 里只放引用（见 SYNC_BLOB_REF / SYNC_BIN_REF）。
 */
export interface SyncRecord {
  kind: string;
  /** 聊天消息是聊天 id，别的记录是空字符串 */
  parent: string;
  id: string;
  /** 服务器写入时分配的全局递增序号 */
  seq: number;
  /** 写下这一版的设备上的时间（同一条记录两边都改了时"后写者赢"用） */
  updatedAt: number;
  deleted: boolean;
  data: unknown;
}

export interface SyncPushRecord {
  kind: string;
  parent: string;
  id: string;
  updatedAt: number;
  deleted: boolean;
  data: unknown;
  /** 这台设备上一次见到的这条记录的 seq（没见过是 0）：云端已经是别的版本时不写，退回云端那一份 */
  base: number;
  /** 聊天消息的 createdAt（data 存成大文件时云端看不到）：新设备只拉最近的消息用 */
  createdAt?: number;
}

export interface SyncPushResult {
  applied: { kind: string; parent: string; id: string; seq: number }[];
  /** 云端已经被别的设备改过的记录（云端现在的那一份）：手机合并后再推 */
  conflicts: SyncRecord[];
}

export interface SyncPullResult {
  records: SyncRecord[];
  /** 下一次从这里接着拉 */
  next: number;
  more: boolean;
  /** 云端现在最大的 seq（显示进度用） */
  head: number;
}

/** 大文件的存放处：绑了 R2 是 r2，没绑是 d1（base64 分块） */
export type SyncBlobStore = 'r2' | 'd1';

export interface SyncBlobInfo {
  mime: string;
  size: number;
  /** d1 分了几块（r2 是 0） */
  parts: number;
}

/** 云端已经有的大文件（POST /v1/sync/blobs/check 的回答） */
export interface SyncBlobCheck {
  blobs: Record<string, SyncBlobInfo>;
}

/** 整条记录太大时，data 换成它：{ $blob: sha256, size }（记录的 JSON 存成一个大文件，可能是 gzip 过的） */
export const SYNC_BLOB_REF = '$blob';
/** 记录里的二进制（图片、语音、模型文件）换成它：{ $bin: sha256, type, mime?, size } */
export const SYNC_BIN_REF = '$bin';
/** JSON 推送按 UTF-8 字节分批；计入 records 包装、记录字段和逗号。 */
export const SYNC_PUSH_MAX_RECORDS = 100;
export const SYNC_PUSH_MAX_BYTES = 1_800_000;
/** D1 的行大小按字节计算；更大的记录由客户端压缩、分块上传后只推引用。 */
export const SYNC_RECORD_MAX_BYTES = 1_000_000;
/** 同步用的大文件 d1 每块最多多少个 base64 字符（D1 一行最多 2 MB） */
export const SYNC_BLOB_PART_CHARS = 1_500_000;

/** 一个 size 字节的文件转成 base64 后分几块（手机和 Worker 用同一个算法） */
export function syncBlobParts(size: number): number {
  return Math.max(1, Math.ceil((Math.ceil(size / 3) * 4) / SYNC_BLOB_PART_CHARS));
}
