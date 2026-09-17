/**
 * Migration 1 — PRD section 12 minimum schema, selection-integrity triggers
 * (DB-002) and the FTS5 search index (DB-004).
 *
 * Checksum-locked: never edit after release; add a new migration instead.
 */
export const MIGRATION_001_STATEMENTS: readonly string[] = [
  `CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_is_custom INTEGER NOT NULL DEFAULT 0 CHECK(title_is_custom IN (0,1)),
  response_language TEXT NOT NULL DEFAULT 'auto'
    CHECK(response_language IN ('auto','ha','fr','en')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  selected_attempt_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, ordinal)
)`,
  `CREATE TABLE assistant_attempts (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN
    ('pending','streaming','stopping','complete','stopped','interrupted','failed')),
  finish_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(turn_id, attempt_number)
)`,
  `CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES assistant_attempts(id) ON DELETE CASCADE,
  artifact_sha256 TEXT NOT NULL,
  runtime_build_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  error_code TEXT,
  started_at INTEGER,
  ended_at INTEGER
)`,
  `CREATE TABLE drafts (
  draft_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
)`,
  'CREATE INDEX conversations_recent ON conversations(updated_at DESC, id DESC)',
  'CREATE INDEX turns_page ON turns(conversation_id, ordinal DESC)',
  'CREATE INDEX attempts_turn ON assistant_attempts(turn_id, attempt_number DESC)',

  // DB-002: a selection is null or an attempt of the same turn.
  `CREATE TRIGGER turns_selection_insert
BEFORE INSERT ON turns
WHEN NEW.selected_attempt_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'selected attempt must belong to the turn');
END`,
  `CREATE TRIGGER turns_selection_update
BEFORE UPDATE OF selected_attempt_id ON turns
WHEN NEW.selected_attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM assistant_attempts a
    WHERE a.id = NEW.selected_attempt_id AND a.turn_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'selected attempt must belong to the turn');
END`,
  `CREATE TRIGGER attempts_turn_immutable
BEFORE UPDATE OF turn_id ON assistant_attempts
WHEN NEW.turn_id <> OLD.turn_id
BEGIN
  SELECT RAISE(ABORT, 'attempt cannot move between turns');
END`,
  `CREATE TRIGGER attempts_delete_clears_selection
BEFORE DELETE ON assistant_attempts
BEGIN
  UPDATE turns SET selected_attempt_id = NULL WHERE selected_attempt_id = OLD.id;
END`,

  // DB-004: literal-text search over titles, user text and terminal selected
  // assistant text. `search_rows` maps FTS rowids to content so index rows can
  // be replaced/deleted by key; its delete trigger keeps the FTS table
  // transactionally consistent, including under ON DELETE CASCADE.
  `CREATE TABLE search_rows (
  rowid INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('title','user','assistant'))
)`,
  `CREATE UNIQUE INDEX search_rows_title ON search_rows(conversation_id) WHERE kind = 'title'`,
  'CREATE UNIQUE INDEX search_rows_turn ON search_rows(turn_id, kind) WHERE turn_id IS NOT NULL',
  'CREATE INDEX search_rows_conversation ON search_rows(conversation_id)',
  `CREATE VIRTUAL TABLE search_index USING fts5(
  body,
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '2 3'
)`,
  `CREATE TRIGGER search_rows_delete
AFTER DELETE ON search_rows
BEGIN
  DELETE FROM search_index WHERE rowid = OLD.rowid;
END`,
];
