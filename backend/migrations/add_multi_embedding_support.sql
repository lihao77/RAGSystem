-- Migration script to add multi-embedding model support

-- 1. Create embedding_models table
CREATE TABLE IF NOT EXISTS embedding_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_key TEXT UNIQUE NOT NULL,           -- Unique identifier: provider_model_dimension
    provider TEXT NOT NULL,                   -- API provider: openai, deepseek, etc.
    model_name TEXT NOT NULL,                 -- Model name: text-embedding-3-small
    vector_dimension INTEGER NOT NULL,        -- Vector dimension: 768, 1536, etc.
    distance_metric TEXT NOT NULL,            -- Distance metric: cosine, l2, ip
    is_active BOOLEAN DEFAULT 0,              -- Is current active model
    api_endpoint TEXT,                        -- API endpoint
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ensure only one active model
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_model ON embedding_models(is_active) WHERE is_active = 1;

-- 2. Modify collections table (add new fields if not exists, sqlite doesn't support IF NOT EXISTS for columns)
-- We will handle this in the python migration script or rely on the application to update it.
-- But we can create a new table collections_v2 if we wanted to be strict, but for now we just keep collections as is
-- and maybe add columns if needed, but the plan says "Remove hardcoded vector_dimension", which is tricky in SQLite.
-- The plan suggests "ALTER TABLE collections DROP COLUMN vector_dimension;" but SQLite DROP COLUMN support is limited in older versions.
-- We will keep the old columns for backward compatibility for now or handle it in Python.

-- 3. Create document_vectors table (Association table)
CREATE TABLE IF NOT EXISTS document_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    model_id INTEGER NOT NULL,                -- Reference to embedding_models.id
    embedding BLOB NOT NULL,                  -- Serialized vector
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doc_id, collection) REFERENCES documents(id, collection) ON DELETE CASCADE,
    FOREIGN KEY (model_id) REFERENCES embedding_models(id) ON DELETE CASCADE,
    UNIQUE(doc_id, collection, model_id)      -- Unique per document+collection+model
);

CREATE INDEX IF NOT EXISTS idx_doc_vectors_doc ON document_vectors(doc_id, collection);
CREATE INDEX IF NOT EXISTS idx_doc_vectors_model ON document_vectors(model_id);
CREATE INDEX IF NOT EXISTS idx_doc_vectors_collection ON document_vectors(collection);

-- 4. Update documents table to add sync status tracking
-- SQLite ALTER TABLE ADD COLUMN is supported
-- We'll check in python if column exists before adding, or just try and ignore error.
-- ALTER TABLE documents ADD COLUMN vector_sync_status TEXT DEFAULT '{}';
-- ALTER TABLE documents ADD COLUMN last_vector_sync TIMESTAMP;
