-- 多设备同步（设计文档 §12）：本机库的每条记录一行（聊天消息按条存，parent 是聊天 id），
-- 服务器分配全局递增的 seq（手机按 seq 增量拉取，不依赖设备时钟）；删除留墓碑（deleted = 1、data 为空），别的设备才收得到删除
CREATE TABLE sync_records (
  kind TEXT NOT NULL,
  parent TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  device_id TEXT,
  data TEXT,
  PRIMARY KEY (kind, parent, id)
);
CREATE UNIQUE INDEX sync_records_seq ON sync_records(seq);

-- 大文件（图片、语音、Live2D 模型、书的原文件、太大的记录）按 SHA-256 存一份。
-- 绑了 R2（SYNC_BUCKET）时文件在 R2，这里只记大小（parts = 0）；没绑时 base64 分块存在 sync_blob_parts
CREATE TABLE sync_blobs (
  hash TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  parts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sync_blob_parts (
  hash TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (hash, part)
);
