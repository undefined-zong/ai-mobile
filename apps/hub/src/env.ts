export interface Env {
  DB: D1Database;
  HUB_PASSWORD: string;
  /** Base64-encoded 32-byte AES key. */
  KEK: string;
  APP_ORIGIN: string;
  APP_URL: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** 多设备同步的大文件（图片、语音、模型）放这个 R2 桶；没绑时 base64 分块存在 D1 */
  SYNC_BUCKET?: R2Bucket;
  /** 没绑 R2 时同步的大文件在 D1 里最多占多少 MB（wrangler.jsonc 的 vars；没有就不限） */
  SYNC_BLOB_QUOTA_MB?: string;
  /** /v1/relay 除了不让浏览器直连的渠道的默认主机，还允许转发到哪些主机（逗号隔开，例如自己的 Fish Audio 镜像） */
  RELAY_HOSTS?: string;
}
