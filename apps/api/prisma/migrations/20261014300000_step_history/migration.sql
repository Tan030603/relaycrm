-- AlterTable
ALTER TABLE "automation_run_steps" ADD COLUMN     "history" JSONB NOT NULL DEFAULT '[]';

