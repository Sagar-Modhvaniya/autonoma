-- CreateEnum
CREATE TYPE "git_provider" AS ENUM ('github', 'gitlab');

-- AlterTable
ALTER TABLE "github_installation" ADD COLUMN     "provider" "git_provider" NOT NULL DEFAULT 'github',
ADD COLUMN     "provider_base_url" TEXT,
ADD COLUMN     "provider_token_enc" TEXT,
ADD COLUMN     "webhook_secret_enc" TEXT;
