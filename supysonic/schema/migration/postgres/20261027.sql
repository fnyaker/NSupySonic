-- Each person's own accounts and what is imported from them (plan
-- multi-provider §15, lot P2): the account's import options, and every item
-- already imported or unticked by its holder: each is imported once, and an
-- unticked one never.
CREATE TABLE IF NOT EXISTS library_item (
    account VARCHAR(36) NOT NULL,
    kind VARCHAR(12) NOT NULL,
    ref VARCHAR(64) NOT NULL,
    excluded BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (account, kind, ref)
);
ALTER TABLE provider_account ADD COLUMN IF NOT EXISTS options TEXT;
