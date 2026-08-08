export interface PostgresConversationMigration { version: number; name: string; sql: string; }

/** Ordered conversation schema migrations shared by fresh and existing deployments. */
export const POSTGRES_CONVERSATION_MIGRATIONS: PostgresConversationMigration[] = [{
  version: 1,
  name: "conversation_sessions_messages_projection",
  sql: `
    CREATE TABLE conversation_workspaces (
      workspace_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'local'),
      display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
      root_path TEXT NOT NULL CHECK (length(btrim(root_path)) > 0),
      canonical_key TEXT NOT NULL CHECK (length(btrim(canonical_key)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, canonical_key),
      UNIQUE (tenant_id, workspace_id)
    );

    CREATE TABLE conversation_sessions (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_user_id TEXT,
      visibility TEXT NOT NULL CHECK (visibility IN ('private','tenant')),
      origin_type TEXT NOT NULL CHECK (origin_type IN ('direct','bot','widget')),
      origin_id TEXT,
      origin_channel TEXT NOT NULL CHECK (origin_channel IN ('web','api','feishu','cron','widget_embed','widget_api')),
      workspace_id TEXT,
      permission_mode TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, session_id),
      FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES conversation_workspaces(tenant_id, workspace_id),
      CHECK (visibility <> 'private' OR owner_user_id IS NOT NULL),
      CHECK (
        (origin_type = 'direct' AND origin_id IS NULL AND owner_user_id IS NOT NULL)
        OR (origin_type = 'bot' AND origin_id IS NOT NULL AND owner_user_id IS NOT NULL)
        OR (origin_type = 'widget' AND origin_id IS NOT NULL)
      ),
      CHECK (
        (origin_type = 'direct' AND origin_channel IN ('web','api'))
        OR (origin_type = 'bot' AND origin_channel IN ('api','feishu','cron'))
        OR (origin_type = 'widget' AND origin_channel IN ('widget_embed','widget_api'))
      )
    );
    CREATE INDEX conversation_sessions_tenant_owner_idx
      ON conversation_sessions(tenant_id, owner_user_id);
    CREATE INDEX conversation_sessions_tenant_visibility_idx
      ON conversation_sessions(tenant_id, visibility);

    CREATE TABLE conversation_messages (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
      content TEXT NOT NULL,
      content_parts JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      thread_key TEXT NOT NULL DEFAULT 'root',
      child_agent_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (session_id, id)
    );
    CREATE INDEX conversation_messages_session_seq_idx
      ON conversation_messages(session_id, seq);
    CREATE INDEX conversation_messages_session_thread_seq_idx
      ON conversation_messages(session_id, thread_key, seq);

    CREATE TABLE conversation_session_list_projection (
      session_id TEXT PRIMARY KEY REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      owner_user_id TEXT,
      visibility TEXT NOT NULL CHECK (visibility IN ('private','tenant')),
      origin_type TEXT NOT NULL CHECK (origin_type IN ('direct','bot','widget')),
      origin_id TEXT,
      origin_channel TEXT NOT NULL,
      workspace_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      first_message TEXT NOT NULL DEFAULT '',
      last_message TEXT NOT NULL DEFAULT '',
      activity_at TIMESTAMPTZ NOT NULL,
      unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0)
    );
    CREATE INDEX conversation_session_list_tenant_owner_activity_idx
      ON conversation_session_list_projection(tenant_id, owner_user_id, activity_at DESC, session_id DESC);
    CREATE INDEX conversation_session_list_tenant_visibility_activity_idx
      ON conversation_session_list_projection(tenant_id, visibility, activity_at DESC, session_id DESC);
    CREATE INDEX conversation_session_list_tenant_origin_activity_idx
      ON conversation_session_list_projection(tenant_id, origin_type, origin_id, activity_at DESC, session_id DESC);
    CREATE INDEX conversation_session_list_tenant_workspace_activity_idx
      ON conversation_session_list_projection(tenant_id, workspace_id, activity_at DESC, session_id DESC);

    CREATE FUNCTION rebuild_conversation_session_list_projection(target_session_id TEXT)
    RETURNS VOID
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target_session conversation_sessions%ROWTYPE;
      first_row RECORD;
      last_row RECORD;
    BEGIN
      SELECT * INTO target_session
      FROM conversation_sessions
      WHERE session_id = target_session_id;

      IF NOT FOUND THEN
        DELETE FROM conversation_session_list_projection WHERE session_id = target_session_id;
        RETURN;
      END IF;

      SELECT content, created_at INTO first_row
      FROM conversation_messages
      WHERE session_id = target_session_id
        AND thread_key = 'root'
        AND child_agent_id IS NULL
        AND role IN ('user','assistant','system')
        AND metadata->>'react_intermediate' IS DISTINCT FROM 'true'
        AND metadata->>'visible_to_user' IS DISTINCT FROM 'false'
        AND metadata->>'conversation_scope' IS DISTINCT FROM 'child'
        AND COALESCE(metadata->>'msg_type','') NOT IN ('intent','observation')
      ORDER BY seq ASC
      LIMIT 1;

      SELECT content, created_at INTO last_row
      FROM conversation_messages
      WHERE session_id = target_session_id
        AND thread_key = 'root'
        AND child_agent_id IS NULL
        AND role IN ('user','assistant','system')
        AND metadata->>'react_intermediate' IS DISTINCT FROM 'true'
        AND metadata->>'visible_to_user' IS DISTINCT FROM 'false'
        AND metadata->>'conversation_scope' IS DISTINCT FROM 'child'
        AND COALESCE(metadata->>'msg_type','') NOT IN ('intent','observation')
      ORDER BY seq DESC
      LIMIT 1;

      INSERT INTO conversation_session_list_projection(
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_id,
        origin_channel, workspace_id, title, first_message, last_message,
        activity_at, unread_count
      ) VALUES (
        target_session.session_id, target_session.tenant_id,
        target_session.owner_user_id, target_session.visibility,
        target_session.origin_type, target_session.origin_id,
        target_session.origin_channel, target_session.workspace_id,
        COALESCE(left(btrim(first_row.content), 30), ''), COALESCE(first_row.content, ''),
        COALESCE(last_row.content, ''), COALESCE(last_row.created_at, target_session.created_at), 0
      )
      ON CONFLICT (session_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        owner_user_id = EXCLUDED.owner_user_id,
        visibility = EXCLUDED.visibility,
        origin_type = EXCLUDED.origin_type,
        origin_id = EXCLUDED.origin_id,
        origin_channel = EXCLUDED.origin_channel,
        workspace_id = EXCLUDED.workspace_id,
        title = EXCLUDED.title,
        first_message = EXCLUDED.first_message,
        last_message = EXCLUDED.last_message,
        activity_at = EXCLUDED.activity_at;
    END;
    $$;

    CREATE FUNCTION project_inserted_conversation_sessions()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE changed_session_id TEXT;
    BEGIN
      FOR changed_session_id IN SELECT DISTINCT session_id FROM inserted_sessions LOOP
        PERFORM rebuild_conversation_session_list_projection(changed_session_id);
      END LOOP;
      RETURN NULL;
    END;
    $$;

    CREATE FUNCTION project_updated_conversation_sessions()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE changed_session_id TEXT;
    BEGIN
      FOR changed_session_id IN
        SELECT DISTINCT new_rows.session_id
        FROM updated_sessions new_rows
        JOIN previous_sessions old_rows USING (session_id)
        WHERE (new_rows.owner_user_id,new_rows.visibility,new_rows.origin_type,new_rows.origin_id,new_rows.origin_channel,new_rows.workspace_id)
          IS DISTINCT FROM
          (old_rows.owner_user_id,old_rows.visibility,old_rows.origin_type,old_rows.origin_id,old_rows.origin_channel,old_rows.workspace_id)
      LOOP
        PERFORM rebuild_conversation_session_list_projection(changed_session_id);
      END LOOP;
      RETURN NULL;
    END;
    $$;

    CREATE FUNCTION project_inserted_conversation_messages()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE changed_session_id TEXT;
    BEGIN
      FOR changed_session_id IN SELECT DISTINCT session_id FROM inserted_messages LOOP
        PERFORM rebuild_conversation_session_list_projection(changed_session_id);
      END LOOP;
      RETURN NULL;
    END;
    $$;

    CREATE FUNCTION project_updated_conversation_messages()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE changed_session_id TEXT;
    BEGIN
      FOR changed_session_id IN
        SELECT DISTINCT session_id FROM (
          SELECT session_id FROM updated_messages
          UNION
          SELECT session_id FROM previous_messages
        ) changed
      LOOP
        PERFORM rebuild_conversation_session_list_projection(changed_session_id);
      END LOOP;
      RETURN NULL;
    END;
    $$;

    CREATE FUNCTION project_deleted_conversation_messages()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE changed_session_id TEXT;
    BEGIN
      FOR changed_session_id IN SELECT DISTINCT session_id FROM deleted_messages LOOP
        PERFORM rebuild_conversation_session_list_projection(changed_session_id);
      END LOOP;
      RETURN NULL;
    END;
    $$;

    CREATE TRIGGER conversation_session_projection_insert_trigger
      AFTER INSERT ON conversation_sessions
      REFERENCING NEW TABLE AS inserted_sessions
      FOR EACH STATEMENT EXECUTE FUNCTION project_inserted_conversation_sessions();
    CREATE TRIGGER conversation_session_projection_update_trigger
      AFTER UPDATE ON conversation_sessions
      REFERENCING OLD TABLE AS previous_sessions NEW TABLE AS updated_sessions
      FOR EACH STATEMENT EXECUTE FUNCTION project_updated_conversation_sessions();
    CREATE TRIGGER conversation_message_projection_insert_trigger
      AFTER INSERT ON conversation_messages
      REFERENCING NEW TABLE AS inserted_messages
      FOR EACH STATEMENT EXECUTE FUNCTION project_inserted_conversation_messages();
    CREATE TRIGGER conversation_message_projection_update_trigger
      AFTER UPDATE ON conversation_messages
      REFERENCING OLD TABLE AS previous_messages NEW TABLE AS updated_messages
      FOR EACH STATEMENT EXECUTE FUNCTION project_updated_conversation_messages();
    CREATE TRIGGER conversation_message_projection_delete_trigger
      AFTER DELETE ON conversation_messages
      REFERENCING OLD TABLE AS deleted_messages
      FOR EACH STATEMENT EXECUTE FUNCTION project_deleted_conversation_messages();
  `,
}, {
  version: 2,
  name: "provider_continuations",
  sql: `
    CREATE TABLE provider_continuations (
      tenant_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      tool_call_ids JSONB NOT NULL,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, message_id),
      FOREIGN KEY (tenant_id, session_id)
        REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id, message_id)
        REFERENCES conversation_messages(session_id, id) ON DELETE CASCADE,
      CHECK (jsonb_typeof(tool_call_ids) = 'array')
    );
    CREATE INDEX provider_continuations_tenant_session_thread_idx
      ON provider_continuations(tenant_id, session_id, thread_key, created_at);
  `,
}, {
  version: 3,
  name: "removable_workspaces",
  sql: `
    ALTER TABLE conversation_workspaces ADD COLUMN removed_at TIMESTAMPTZ;
    CREATE INDEX conversation_workspaces_active_idx
      ON conversation_workspaces(tenant_id, display_name, workspace_id)
      WHERE removed_at IS NULL;
  `,
}, {
  version: 4,
  name: "purge_unused_removed_workspaces",
  sql: `
    DELETE FROM conversation_workspaces w
    WHERE w.removed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM conversation_sessions s
        WHERE s.tenant_id=w.tenant_id AND s.workspace_id=w.workspace_id
      );
  `,
}, {
  version: 5,
  name: "conversation_message_content_parts",
  sql: `
    ALTER TABLE conversation_messages
      ADD COLUMN IF NOT EXISTS content_parts JSONB NOT NULL DEFAULT '[]'::jsonb;

    UPDATE conversation_messages AS message
    SET content_parts = COALESCE(
      (
        SELECT extension #> '{data,parts}'
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(message.metadata->'extensions') = 'array'
            THEN message.metadata->'extensions' ELSE '[]'::jsonb END
        ) AS extensions(extension)
        WHERE extension->>'kind' = 'rich_content'
          AND jsonb_typeof(extension #> '{data,parts}') = 'array'
        LIMIT 1
      ),
      CASE WHEN message.content <> ''
        THEN jsonb_build_array(jsonb_build_object('type', 'text', 'text', message.content))
        ELSE '[]'::jsonb END
    )
    WHERE message.content_parts = '[]'::jsonb;

    UPDATE conversation_messages AS message
    SET content_parts = message.content_parts || COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'type', 'attachment_ref',
          'file_id', item->>'file_id',
          'original_name', item->>'original_name',
          'stored_name', item->>'stored_name',
          'mime', COALESCE(item->>'mime', ''),
          'size', item->'size',
          'kind', CASE WHEN item->>'kind' = 'image' THEN 'image' ELSE 'file' END,
          'presentation', CASE WHEN item->>'kind' = 'image' THEN 'inline' ELSE 'attachment' END
        )
        || CASE WHEN NULLIF(item->>'file_path', '') IS NOT NULL
          THEN jsonb_build_object('file_path', item->>'file_path') ELSE '{}'::jsonb END
        || CASE WHEN item->>'file_path_space' IN ('uploads', 'absolute')
          THEN jsonb_build_object('file_path_space', item->>'file_path_space') ELSE '{}'::jsonb END
      )
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(message.metadata->'extensions') = 'array'
          THEN message.metadata->'extensions' ELSE '[]'::jsonb END
      ) AS extensions(extension)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN extension->>'kind' = 'attachments'
          AND jsonb_typeof(extension #> '{data,items}') = 'array'
          THEN extension #> '{data,items}' ELSE '[]'::jsonb END
      ) AS items(item)
      WHERE NULLIF(item->>'file_id', '') IS NOT NULL
        AND NULLIF(item->>'original_name', '') IS NOT NULL
        AND NULLIF(item->>'stored_name', '') IS NOT NULL
        AND jsonb_typeof(item->'size') = 'number'
    ), '[]'::jsonb)
    WHERE jsonb_typeof(message.metadata->'extensions') = 'array';

    WITH cleaned AS (
      SELECT message.id, COALESCE((
        SELECT jsonb_agg(extension)
        FROM jsonb_array_elements(message.metadata->'extensions') AS extensions(extension)
        WHERE extension->>'kind' NOT IN ('rich_content', 'attachments')
      ), '[]'::jsonb) AS extensions
      FROM conversation_messages AS message
      WHERE jsonb_typeof(message.metadata->'extensions') = 'array'
    )
    UPDATE conversation_messages AS message
    SET metadata = CASE WHEN cleaned.extensions = '[]'::jsonb
      THEN message.metadata - 'extensions'
      ELSE jsonb_set(message.metadata, '{extensions}', cleaned.extensions, true)
    END
    FROM cleaned
    WHERE message.id = cleaned.id;
  `,
}, {
  version: 6,
  name: "canonical_command_content_parts",
  sql: `
    UPDATE conversation_messages AS message
    SET content_parts = jsonb_build_array(
      jsonb_build_object(
        'type', 'command_result',
        'invocation_id', COALESCE((
          SELECT 'cmd_' || command.id
          FROM conversation_messages AS command
          WHERE command.session_id = message.session_id
            AND command.thread_key = message.thread_key
            AND command.seq < message.seq
            AND command.metadata->>'msg_type' = 'command'
          ORDER BY command.seq DESC
          LIMIT 1
        ), 'cmd_result_' || message.id),
        'name', COALESCE(NULLIF(message.metadata->>'command', ''), 'unknown'),
        'success', CASE WHEN message.metadata->>'success' = 'false' THEN false ELSE true END,
        'text', message.content
      ) || CASE WHEN NULLIF(message.metadata->>'error', '') IS NOT NULL
        THEN jsonb_build_object('error', message.metadata->>'error') ELSE '{}'::jsonb END
    ),
    metadata = message.metadata
      - 'msg_type' - 'command' - 'command_mode' - 'expanded_task' - 'success' - 'error'
    WHERE message.metadata->>'msg_type' = 'command_result';

    UPDATE conversation_messages AS message
    SET content_parts = jsonb_build_array(
      jsonb_build_object(
        'type', 'command_ref',
        'invocation_id', 'cmd_' || message.id,
        'name', COALESCE(
          NULLIF(message.metadata->>'command', ''),
          NULLIF(lower(substring(message.content FROM '^\\s*/([^\\s/]+)')), ''),
          'unknown'
        ),
        'args', regexp_replace(btrim(message.content), '^/[^[:space:]/]+[[:space:]]*', ''),
        'raw_text', CASE WHEN message.content <> '' THEN message.content ELSE '/unknown' END,
        'resolution', CASE
          WHEN message.metadata->>'command_mode' = 'prompt'
            AND NULLIF(message.metadata->>'expanded_task', '') IS NOT NULL
          THEN jsonb_build_object(
            'kind', 'prompt',
            'agent_text', message.metadata->>'expanded_task',
            'snapshot_id', 'migration:' || message.id
          )
          ELSE jsonb_build_object('kind', 'system')
        END
      )
    ) || CASE
      WHEN message.content_parts->0->>'type' = 'text'
        AND message.content_parts->0->>'text' = message.content
      THEN message.content_parts - 0
      ELSE message.content_parts
    END,
    metadata = message.metadata
      - 'msg_type' - 'command' - 'command_mode' - 'expanded_task' - 'success' - 'error'
    WHERE message.metadata->>'msg_type' = 'command';
  `,
}];
