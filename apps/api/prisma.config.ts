import { defineConfig } from 'prisma/config';

// The CLI (migrate) connects as the table owner. The running app never uses this
// URL: it connects as app_user (DATABASE_URL) so RLS applies.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.MIGRATION_DATABASE_URL ?? '' },
});
