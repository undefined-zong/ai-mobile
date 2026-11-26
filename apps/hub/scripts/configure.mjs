import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const id = process.env.HUB_D1_ID || config.d1_databases[0].database_id;
if (!/^[0-9a-f-]{36}$/i.test(id) || /^0+-0+-0+-0+-0+$/.test(id)) throw new Error('Set HUB_D1_ID to the D1 database UUID');
config.d1_databases[0].database_id = id;
if (process.env.CLOUDFLARE_ACCOUNT_ID) config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
if (process.env.HUB_APP_URL) {
  const url = new URL(process.env.HUB_APP_URL);
  config.vars.APP_URL = url.href;
  config.vars.APP_ORIGIN = url.origin;
}
// 没绑 R2 时同步的图片在 D1 里最多占多少 MB：不设就用 wrangler.jsonc 里 vars 的 SYNC_BLOB_QUOTA_MB
if (process.env.HUB_BLOB_QUOTA_MB) {
  const mb = Number(process.env.HUB_BLOB_QUOTA_MB);
  if (!Number.isFinite(mb) || mb <= 0) throw new Error('HUB_BLOB_QUOTA_MB must be a positive number of MB');
  config.vars.SYNC_BLOB_QUOTA_MB = String(mb);
}
// /v1/relay 额外允许转发的主机（逗号隔开）：不设就用 wrangler.jsonc 里 vars 的 RELAY_HOSTS
if (process.env.HUB_RELAY_HOSTS) config.vars.RELAY_HOSTS = process.env.HUB_RELAY_HOSTS;
// 多设备同步的图片、语音、模型放进 R2（可选）：没设时 base64 分块存在 D1
if (process.env.HUB_R2_BUCKET) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(process.env.HUB_R2_BUCKET)) throw new Error('HUB_R2_BUCKET is not a valid R2 bucket name');
  config.r2_buckets = [{ binding: 'SYNC_BUCKET', bucket_name: process.env.HUB_R2_BUCKET }];
}
writeFileSync(new URL('../wrangler.deploy.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
console.log('Wrote apps/hub/wrangler.deploy.json (no secrets)');
