# -*- coding: utf-8 -*-
"""
Migrate existing vector store to multi-embedding model architecture.

This script:
1. Initializes the new database schema (embedding_models, document_vectors).
2. Registers the current embedding model.
3. Migrates existing vectors from the 'vectors' virtual table to 'document_vectors' table.
"""

import sys
import os
import sqlite3
import struct
import logging

# Add backend to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vector_store.model_manager import EmbeddingModelManager
from config import get_config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def migrate():
    config = get_config()
    # Correct path access for sqlite_vec config
    db_path = config.vector_store.sqlite_vec.database_path
    
    if not os.path.exists(db_path):
        logger.error(f"Database not found at {db_path}")
        return

    logger.info(f"Opening database: {db_path}")
    
    # Initialize Model Manager (creates new tables)
    model_manager = EmbeddingModelManager(db_path)
    
    # 1. Get current configuration
    # We try to infer current model details from config or database
    conn = sqlite3.connect(db_path)
    
    # Load sqlite-vec extension
    try:
        import sqlite_vec
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        logger.info("Loaded sqlite-vec extension")
    except Exception as e:
        logger.warning(f"Failed to load sqlite-vec extension: {e}")

    conn.row_factory = sqlite3.Row
    
    # Check if collections table has vector_dimension
    try:
        cursor = conn.execute("SELECT vector_dimension, distance_metric FROM collections LIMIT 1")
        row = cursor.fetchone()
        if row:
            current_dimension = row['vector_dimension']
            current_metric = row['distance_metric']
        else:
            # Fallback to config
            from vector_store.embedder import get_embedder
            embedder = get_embedder()
            current_dimension = embedder.embedding_dim
            current_metric = "cosine" # Default
    except Exception as e:
        logger.warning(f"Could not determine current dimension from DB: {e}")
        # Fallback to config
        from vector_store.embedder import get_embedder
        embedder = get_embedder()
        current_dimension = embedder.embedding_dim
        current_metric = "cosine"

    # Register current model
    # We assume the current config matches the data in DB for the "default" model
    mode = config.embedding.mode
    if mode == 'remote':
        # Try to parse provider from endpoint or use 'openai' as default generic
        api_endpoint = config.embedding.remote.api_endpoint
        model_name = config.embedding.remote.model_name
        if 'openai' in api_endpoint:
            provider_name = 'openai'
        elif 'deepseek' in api_endpoint:
            provider_name = 'deepseek'
        else:
            provider_name = 'custom'
    else:
        provider_name = 'local'
        model_name = config.embedding.local.model_name

    logger.info(f"Registering current model: {provider_name}/{model_name} ({current_dimension}d)")
    
    model_id = model_manager.register_model(
        provider=provider_name,
        model_name=model_name,
        vector_dimension=current_dimension,
        distance_metric=current_metric,
        api_endpoint=config.embedding.remote.api_endpoint if mode == 'remote' else None,
        set_active=True
    )
    
    # 2. Migrate vectors
    logger.info("Migrating vectors...")
    
    # Check if vectors table exists
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='vectors'")
    if not cursor.fetchone():
        logger.info("No 'vectors' table found. Skipping vector migration.")
        return

    # Count vectors
    cursor = conn.execute("SELECT COUNT(*) FROM vectors")
    total_vectors = cursor.fetchone()[0]
    
    if total_vectors == 0:
        logger.info("No vectors to migrate.")
        return

    logger.info(f"Found {total_vectors} vectors to migrate.")
    
    # Migrate in batches
    BATCH_SIZE = 1000
    migrated_count = 0
    
    # We read from vectors table and insert into document_vectors
    # vectors table has: doc_id, collection, embedding
    
    cursor = conn.execute("SELECT doc_id, collection, embedding FROM vectors")
    
    while True:
        rows = cursor.fetchmany(BATCH_SIZE)
        if not rows:
            break
            
        with model_manager.conn: # Use model_manager's connection for transaction
            for row in rows:
                doc_id = row['doc_id']
                collection = row['collection']
                embedding_blob = row['embedding'] 
                
                # Check if already migrated
                exists = model_manager.conn.execute(
                    "SELECT 1 FROM document_vectors WHERE doc_id = ? AND collection = ? AND model_id = ?",
                    (doc_id, collection, model_id)
                ).fetchone()
                
                if not exists:
                    model_manager.conn.execute(
                        """
                        INSERT INTO document_vectors (doc_id, collection, model_id, embedding)
                        VALUES (?, ?, ?, ?)
                        """,
                        (doc_id, collection, model_id, embedding_blob)
                    )
        
        migrated_count += len(rows)
        print(f"Migrated {migrated_count}/{total_vectors}", end='\r')

    print()
    logger.info("Migration completed successfully.")
    
    # Verify migration
    stats = model_manager.get_model_stats(model_id)
    logger.info(f"New stats: {stats}")
    
    conn.close()
    model_manager.close()

if __name__ == "__main__":
    migrate()
