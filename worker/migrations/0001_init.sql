CREATE TABLE vault_versions (
  vault      TEXT NOT NULL,
  version    INTEGER NOT NULL,
  blob       BLOB NOT NULL,
  sha256     TEXT NOT NULL,
  device     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (vault, version)
);
