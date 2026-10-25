-- Who may use which provider account (plan multi-provider §15): groups of
-- people, their members, the grants, and how an account was signed in.
CREATE TABLE IF NOT EXISTS user_group (
    id UUID PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    created TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS user_group_member (
    group_id UUID NOT NULL REFERENCES user_group ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES "user" ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS index_user_group_member_user_id_fk ON user_group_member(user_id);
CREATE TABLE IF NOT EXISTS provider_grant (
    provider VARCHAR(16) NOT NULL,
    account VARCHAR(36) NOT NULL,
    feature VARCHAR(16) NOT NULL,
    subject VARCHAR(40) NOT NULL,
    PRIMARY KEY (provider, account, feature, subject)
);
ALTER TABLE provider_account ADD COLUMN IF NOT EXISTS mode VARCHAR(16);
