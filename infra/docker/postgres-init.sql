-- Runs once when the dev database volume is first created.
-- The API connects as app_user: not a superuser, not the table owner, no BYPASSRLS,
-- so Row-Level Security always applies to it. Migrations grant it table access.
CREATE ROLE app_user LOGIN PASSWORD 'app_user_dev' NOSUPERUSER NOBYPASSRLS;

-- Streaming replication (docker compose --profile replica): read-only replica for dashboards and history.
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator_dev';
