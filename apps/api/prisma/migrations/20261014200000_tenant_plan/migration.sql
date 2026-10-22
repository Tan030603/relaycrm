-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

