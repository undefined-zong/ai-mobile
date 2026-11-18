-- 日程系统（生活计划）：手机上传每个人设的设置和材料，每天到点（按人设设的时间和时区）云端连 MCP、排这周和今天的计划
CREATE TABLE planner_contexts (
  persona_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 每个人设每天一份结果（手机按 done_at 拉）
CREATE TABLE planner_jobs (
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
CREATE INDEX planner_jobs_done ON planner_jobs(done_at);
-- MCP 服务器的地址、Token（加密）；OAuth 的 Token 刷新后写回这里
CREATE TABLE planner_mcp (
  server_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
