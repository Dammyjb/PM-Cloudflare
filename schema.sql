-- Feedback Intelligence Agent Database Schema
-- Run with: npx wrangler d1 execute feedback-db --file=./schema.sql

-- Feedback items from all sources (GitHub, Discord, Zendesk, etc.)
CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    label TEXT,
    author TEXT,
    created_at TEXT NOT NULL,
    ingested_at TEXT DEFAULT CURRENT_TIMESTAMP,
    raw_metadata TEXT
);

-- Classification results based on our PM framework
CREATE TABLE IF NOT EXISTS classifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id TEXT NOT NULL UNIQUE,
    urgency INTEGER NOT NULL CHECK (urgency BETWEEN 1 AND 5),
    sentiment INTEGER NOT NULL CHECK (sentiment BETWEEN -2 AND 2),
    impact INTEGER NOT NULL CHECK (impact BETWEEN 1 AND 5),
    actionability INTEGER NOT NULL CHECK (actionability BETWEEN 1 AND 5),
    route TEXT,
    confidence REAL,
    reasoning TEXT,
    classified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (feedback_id) REFERENCES feedback(id)
);

-- Extracted signals and entities (feature areas, user segments, etc.)
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    signal_value TEXT NOT NULL,
    confidence REAL,
    FOREIGN KEY (feedback_id) REFERENCES feedback(id)
);

-- PM summaries and reports
CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    summary_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metrics TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_classifications_route ON classifications(route);
CREATE INDEX IF NOT EXISTS idx_classifications_urgency ON classifications(urgency);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(signal_type);
