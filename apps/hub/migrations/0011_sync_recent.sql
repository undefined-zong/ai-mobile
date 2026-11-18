-- 长聊天（几十万条消息）：新设备第一次同步每个聊天只拉最近的，更早的往上翻时再按时间往前取。
-- created_at 是消息的 createdAt（别的记录为空），推送时写入；已有的从 data 里取出来
ALTER TABLE sync_records ADD COLUMN created_at INTEGER;
UPDATE sync_records SET created_at = json_extract(data, '$.createdAt')
  WHERE kind = 'message' AND deleted = 0 AND data IS NOT NULL AND json_valid(data);
CREATE INDEX sync_records_msgs ON sync_records(kind, parent, created_at, seq);
