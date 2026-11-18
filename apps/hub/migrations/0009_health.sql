-- 健康计划：手机上传每个人设拼好的材料（健康设置、今天和明天的运动记录、附近的店），
-- 每天到点（人设设的时间和时区，默认 04:00）云端排今天的健身和三顿饭（这周的还没排就先排这周），结果留给手机拉取
CREATE TABLE health_contexts (
  persona_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 每个人设每天一份（手机按 done_at 拉）
CREATE TABLE health_jobs (
  persona_id TEXT NOT NULL,
  date TEXT NOT NULL,
  result TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at INTEGER,
  PRIMARY KEY (persona_id, date)
);
CREATE INDEX health_jobs_done ON health_jobs(done_at);
