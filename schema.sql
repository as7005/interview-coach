-- Long-term memory: survives across sessions, per user.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  topic_area TEXT NOT NULL,       -- e.g. "system-design", "behavioral-conflict"
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  score INTEGER NOT NULL,         -- 1-5
  feedback TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Rolling weak-area tracker, updated after each answer.
CREATE TABLE IF NOT EXISTS topic_scores (
  user_id TEXT NOT NULL,
  topic_area TEXT NOT NULL,
  avg_score REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, topic_area)
);
