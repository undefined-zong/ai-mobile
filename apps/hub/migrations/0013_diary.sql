-- 日记：手机上传每个开了"主动写日记"的角色写日记要的东西（角色卡、今天的节律、今天和你、记得的事、最近几篇日记）；
-- Cron 每晚 22:00（按上传的时区）替她写当天的日记，一个角色一天一篇，结果留给手机拉取（配图由手机画）
CREATE TABLE diary_contexts (
  character_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE diary_entries (
  character_id TEXT NOT NULL,
  date TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  data TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at INTEGER,
  PRIMARY KEY (character_id, date)
);
CREATE INDEX diary_entries_done ON diary_entries(done_at);
