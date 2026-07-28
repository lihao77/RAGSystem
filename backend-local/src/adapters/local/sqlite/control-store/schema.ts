export const CONTROL_BASELINE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roles (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (user_id, tenant_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (role) REFERENCES roles(name) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_memberships_tenant_id ON memberships(tenant_id);
`;


export const CONTROL_AUTH_SCHEMA_SQL = `
  ALTER TABLE users ADD COLUMN password_hash TEXT;
  ALTER TABLE users ADD COLUMN username TEXT;
  CREATE UNIQUE INDEX idx_users_username ON users(username);

  CREATE TABLE user_sessions (
    jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
  CREATE INDEX idx_user_sessions_tenant_id ON user_sessions(tenant_id);
  CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);

  CREATE TABLE system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const CONTROL_BOT_SCHEMA_SQL = `
  ALTER TABLE users ADD COLUMN type TEXT NOT NULL DEFAULT 'human';
  ALTER TABLE users ADD COLUMN owner_id TEXT;
  CREATE INDEX idx_users_owner_id ON users(owner_id);
`;

export const CONTROL_BOT_CONFIG_SCHEMA_SQL = `
  CREATE TABLE bot_configs (
    bot_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    entry_agent TEXT,
    session_id TEXT,
    default_session_ttl INTEGER NOT NULL DEFAULT 86400,
    feishu_app_id TEXT,
    feishu_app_secret TEXT,
    feishu_token TEXT,
    feishu_encoding_aes_key TEXT,
    feishu_receive_mode TEXT NOT NULL DEFAULT 'webhook',
    feishu_route_token TEXT,
    feishu_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (bot_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_bot_configs_tenant_id ON bot_configs(tenant_id);
  CREATE INDEX idx_bot_configs_feishu_enabled ON bot_configs(feishu_enabled);
  CREATE UNIQUE INDEX idx_bot_configs_feishu_route_token ON bot_configs(feishu_route_token) WHERE feishu_route_token IS NOT NULL;

  CREATE TABLE bot_cron_tasks (
    bot_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    cron TEXT NOT NULL,
    task TEXT NOT NULL,
    entry_agent TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    push_platform TEXT,
    push_chat_id TEXT,
    next_run REAL,
    last_run REAL,
    last_result TEXT,
    PRIMARY KEY (bot_id, task_id),
    FOREIGN KEY (bot_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_bot_cron_tasks_next_run ON bot_cron_tasks(enabled, next_run);

  INSERT INTO bot_configs(
    bot_id, tenant_id, enabled, entry_agent, session_id, default_session_ttl,
    feishu_app_id, feishu_app_secret, feishu_token, feishu_encoding_aes_key,
    feishu_receive_mode, feishu_route_token, feishu_enabled, created_at, updated_at
  )
  SELECT u.id, MIN(m.tenant_id), 0, NULL, NULL, 86400, NULL, NULL, NULL, NULL, 'webhook', NULL, 0, u.created_at, u.created_at
  FROM users u
  JOIN memberships m ON m.user_id = u.id
  WHERE u.type = 'bot'
  GROUP BY u.id;
`;
