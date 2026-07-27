/** Clean-break development baseline. Existing databases are intentionally unsupported. */
export const BASELINE_SCHEMA_SQL = `
    CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('local')),
      display_name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, canonical_key),
      UNIQUE(tenant_id, workspace_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_user_id TEXT,
      visibility TEXT NOT NULL CHECK(visibility IN ('private', 'tenant')),
      origin_type TEXT NOT NULL CHECK(origin_type IN ('direct', 'bot', 'widget')),
      origin_id TEXT,
      origin_channel TEXT NOT NULL CHECK(origin_channel IN ('web', 'api', 'feishu', 'cron', 'widget_embed', 'widget_api')),
      workspace_id TEXT,
      permission_mode TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id),
      CHECK(visibility != 'private' OR owner_user_id IS NOT NULL),
      CHECK(
        (origin_type = 'direct' AND origin_id IS NULL AND owner_user_id IS NOT NULL)
        OR (origin_type = 'bot' AND origin_id IS NOT NULL AND owner_user_id IS NOT NULL)
        OR (origin_type = 'widget' AND origin_id IS NOT NULL)
      ),
      CHECK(
        (origin_type = 'direct' AND origin_channel IN ('web', 'api'))
        OR (origin_type = 'bot' AND origin_channel IN ('api', 'feishu', 'cron'))
        OR (origin_type = 'widget' AND origin_channel IN ('widget_embed', 'widget_api'))
      )
    );

    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      thread_key TEXT NOT NULL DEFAULT 'root',
      child_agent_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session_thread_seq ON messages(session_id, thread_key, seq);
    CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(tenant_id, owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_origin ON sessions(tenant_id, origin_type, origin_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(tenant_id, workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_name ON workspaces(tenant_id, display_name);

    CREATE TABLE session_list_projection (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_user_id TEXT,
      visibility TEXT NOT NULL CHECK(visibility IN ('private', 'tenant')),
      origin_type TEXT NOT NULL CHECK(origin_type IN ('direct', 'bot', 'widget')),
      origin_id TEXT,
      origin_channel TEXT NOT NULL,
      workspace_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      first_message TEXT NOT NULL DEFAULT '',
      last_message TEXT NOT NULL DEFAULT '',
      activity_at TIMESTAMP NOT NULL,
      unread_count INTEGER NOT NULL DEFAULT 0 CHECK(unread_count >= 0),
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY(tenant_id, workspace_id) REFERENCES workspaces(tenant_id, workspace_id)
    );
    CREATE INDEX idx_session_list_private_activity ON session_list_projection(tenant_id, owner_user_id, activity_at DESC, session_id DESC);
    CREATE INDEX idx_session_list_tenant_activity ON session_list_projection(tenant_id, visibility, activity_at DESC, session_id DESC);
    CREATE INDEX idx_session_list_origin_activity ON session_list_projection(tenant_id, origin_type, origin_id, activity_at DESC, session_id DESC);
    CREATE INDEX idx_session_list_workspace_activity ON session_list_projection(tenant_id, workspace_id, activity_at DESC, session_id DESC);

    CREATE TABLE IF NOT EXISTS run_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_id TEXT,
      session_id TEXT NOT NULL,
      message_id TEXT,
      step_order INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tenant_id TEXT,
      entrypoint TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      task_summary TEXT,
      request_id TEXT,
      user_id TEXT,
      agent_name TEXT,
      thread_key TEXT NOT NULL DEFAULT 'root',
      parent_run_id TEXT,
      parent_call_id TEXT,
      final_message_id TEXT,
      child_agent_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS resources (
      resource_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT,
      step_id INTEGER,
      message_id TEXT,
      resource_type TEXT NOT NULL,
      sub_type TEXT,
      title TEXT,
      path TEXT NOT NULL,
      source_tool TEXT,
      scope TEXT NOT NULL DEFAULT 'transient',
      metadata TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS step_resources (
      step_id INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT,
      PRIMARY KEY(step_id, resource_id)
    );

    CREATE TABLE IF NOT EXISTS child_agents (
      child_agent_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_seq INTEGER,
      created_by_run_id TEXT,
      created_by_call_id TEXT,
      parent_run_id TEXT,
      parent_call_id TEXT,
      last_run_id TEXT,
      metadata TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_event_seq (
      session_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS event_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL,
      tenant_id TEXT,
      run_id TEXT,
      session_seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      locked_at TIMESTAMP,
      delivered_at TIMESTAMP,
      last_error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_run_steps_session_run ON run_steps(session_id, run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_steps_event_id ON run_steps(event_id) WHERE event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_run_steps_message_id ON run_steps(message_id);
    CREATE INDEX IF NOT EXISTS idx_run_steps_session_type_id ON run_steps(session_id, step_type, id DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_runs_session_thread_created ON runs(session_id, thread_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_resources_session_run ON resources(session_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_child_agents_session_created ON child_agents(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_child_agents_session_agent ON child_agents(session_id, agent_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_child_agents_session_thread ON child_agents(session_id, thread_key);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_pending ON event_outbox(status, available_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_outbox_session_seq ON event_outbox(session_id, session_seq);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_run_seq ON event_outbox(run_id, session_seq);

    CREATE TABLE agent_call_metrics (
      metric_id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, session_id TEXT, run_id TEXT, task_id TEXT,
      execution_kind TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0,
      token_in INTEGER NOT NULL DEFAULT 0, token_out INTEGER NOT NULL DEFAULT 0,
      tool_usage TEXT NOT NULL DEFAULT '{}', error_type TEXT, model TEXT,
      started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX idx_agent_call_metrics_agent_started ON agent_call_metrics(agent_name, started_at);

    CREATE TABLE pending_interactions (
      interaction_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
      root_run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, batch_id TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, request_payload TEXT NOT NULL,
      resolution_payload TEXT, resume_claim_id TEXT, resume_claim_expires_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      responded_at TIMESTAMP, consumed_at TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_pending_interactions_session_status ON pending_interactions(session_id, status, updated_at);
    CREATE INDEX idx_pending_interactions_root_batch ON pending_interactions(session_id, root_run_id, batch_id, status);
    CREATE INDEX idx_pending_interactions_tool ON pending_interactions(session_id, tool_call_id, status);
    CREATE INDEX idx_pending_interactions_resume_claim ON pending_interactions(session_id, root_run_id, resume_claim_id) WHERE resume_claim_id IS NOT NULL;
    CREATE INDEX idx_pending_interactions_resume_claim_expiry ON pending_interactions(session_id, status, resume_claim_expires_at);

    CREATE TABLE provider_continuations (
      message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, thread_key TEXT NOT NULL,
      provider_type TEXT NOT NULL, tool_call_ids TEXT NOT NULL, state TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_provider_continuations_session_thread ON provider_continuations(session_id, thread_key, created_at);

    CREATE TABLE memory_candidates (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      target_scope TEXT NOT NULL CHECK(target_scope IN ('team', 'agent')),
      operation TEXT NOT NULL DEFAULT 'publish', target_file_name TEXT, team_name TEXT NOT NULL,
      agent_name TEXT, name TEXT NOT NULL, description TEXT NOT NULL, memory_type TEXT NOT NULL,
      content TEXT NOT NULL, why TEXT, how_to_apply TEXT,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'approved', 'rejected', 'withdrawn')),
      source_session_id TEXT, source_run_id TEXT, source_message_id TEXT, reviewer_user_id TEXT,
      review_comment TEXT, published_file_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, reviewed_at TIMESTAMP,
      review_claimed_at TIMESTAMP, review_attempt_id TEXT
    );
    CREATE INDEX idx_memory_candidates_owner_status ON memory_candidates(owner_user_id, status, updated_at DESC);
    CREATE INDEX idx_memory_candidates_target_status ON memory_candidates(target_scope, team_name, agent_name, status, updated_at DESC);
    CREATE INDEX idx_memory_candidates_operation_status ON memory_candidates(operation, status, updated_at DESC);
    CREATE INDEX idx_memory_candidates_review_claim ON memory_candidates(status, reviewer_user_id, review_claimed_at);
    CREATE INDEX idx_memory_candidates_review_attempt ON memory_candidates(id, status, review_attempt_id);

    CREATE TABLE workflow_tasks (
      task_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, subject TEXT NOT NULL,
      description TEXT NOT NULL, active_form TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed')),
      blocks TEXT NOT NULL DEFAULT '[]', blocked_by TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_workflow_tasks_session_task ON workflow_tasks(session_id, task_id);

    CREATE TABLE workflow_goals (
      goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, objective TEXT NOT NULL,
      success_criteria TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]',
      checkpoint TEXT NOT NULL DEFAULT '{}', progress TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'blocked')),
      continuation_count INTEGER NOT NULL DEFAULT 0, no_progress_count INTEGER NOT NULL DEFAULT 0,
      continuation_generation INTEGER NOT NULL DEFAULT 0,
      continuation_pending INTEGER NOT NULL DEFAULT 0 CHECK(continuation_pending IN (0, 1)),
      continuation_claimed_at TEXT, last_progress_fingerprint TEXT, continuation_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_workflow_goals_session_created ON workflow_goals(session_id, created_at DESC);
    CREATE UNIQUE INDEX workflow_goals_session_current_idx ON workflow_goals(session_id) WHERE status IN ('active', 'paused');
  `;
