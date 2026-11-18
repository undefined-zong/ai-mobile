-- 社群：手机上传每个你加入的社群发帖要的东西（社群的介绍、设置、你邀请进来的角色、最近的帖子）；
-- Cron 每天在随机的时间替网友发几批帖子、替加入的角色发帖（按社群和日期算出来的时间，一批一个格子），结果留给手机拉取。
-- 角色的帖子用她自己上传的朋友圈上下文（social_contexts）；API 用云端朋友圈的那一份（secrets 里的 social）。
CREATE TABLE community_contexts (
  community_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE community_posts (
  community_id TEXT NOT NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  data TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at INTEGER,
  PRIMARY KEY (community_id, date, slot)
);
CREATE INDEX community_posts_done ON community_posts(done_at);
