-- 平行时空 · 整理你的一天：手机上传每个人设今天、明天的家务和健康计划（日程计划用云端自己排的），
-- 每天到点（人设设的时间和时区，在日程计划排好之后）把几份计划整理成平行时空里的一份，结果留给手机拉取
CREATE TABLE parallel_plan_contexts (
  persona_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 每个人设每天一份（手机按 done_at 拉）
CREATE TABLE parallel_plans (
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
CREATE INDEX parallel_plans_done ON parallel_plans(done_at);
