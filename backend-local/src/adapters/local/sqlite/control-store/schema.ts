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
