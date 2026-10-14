-- Runs once when the dev database volume is first created.
-- The API connects as app_user: not a superuser, not the table owner, no BYPASSRLS,
-- so Row-Level Security always applies to it. Migrations grant it table access.
CREATE ROLE app_user LOGIN PASSWORD 'app_user_dev' NOSUPERUSER NOBYPASSRLS;
