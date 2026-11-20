-- 手表的运动数据：iPhone 的快捷指令、Health Auto Export 推上来（POST /v1/ingest/workout、/v1/ingest/hae，用单独的上报令牌），
-- 读成同一个样子（packages/shared/src/watchWorkout.ts）存在这里；手机按 seq 拉回去，和"健身"里记的那次对上。
-- 同一次运动再推一次（id 一样）内容变了才换一行（seq 变大，手机会再拉一次），没变就不动
CREATE TABLE workout_ingest (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX workout_ingest_started ON workout_ingest(started_at);
