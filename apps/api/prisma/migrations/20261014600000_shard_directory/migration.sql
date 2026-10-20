-- Shard directory for tenant cells (see Db in src/db.ts). Global tables: no tenant RLS,
-- like users and refresh_tokens. Present in every cell; only the default cell's copy is used.
CREATE TABLE "tenant_shards" (
    "tenant_id" UUID NOT NULL,
    "shard" TEXT NOT NULL,
    CONSTRAINT "tenant_shards_pkey" PRIMARY KEY ("tenant_id")
);

CREATE TABLE "user_shards" (
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "shard" TEXT NOT NULL,
    CONSTRAINT "user_shards_pkey" PRIMARY KEY ("user_id")
);
CREATE UNIQUE INDEX "user_shards_email_key" ON "user_shards"("email");

-- Existing users live in the default cell. users has no RLS, so this sees them all.
INSERT INTO user_shards (user_id, email, shard) SELECT id, email, 'default' FROM users ON CONFLICT DO NOTHING;
