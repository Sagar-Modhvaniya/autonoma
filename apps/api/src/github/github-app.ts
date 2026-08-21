import { db } from "@autonoma/db";
import { GitLabApp, type GitHubApp, LocalDevGitHubApp, OctokitGitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { env as apiEnv } from "../env";
import { PrismaEtagStore } from "./prisma-etag-store";

type ApiEnv = typeof apiEnv;

export function buildGitHubApp(env: ApiEnv): GitHubApp {
    if (env.LOCAL_DEV) {
        logger.info("LOCAL_DEV=true - using LocalDevGitHubApp (fake GitHub integration)");
        return new LocalDevGitHubApp();
    }

    // An explicitly configured GitLab connection takes the GitHub App's place:
    // same interfaces, repos are projects, pull requests are merge requests.
    if (env.GITLAB_BASE_URL != null && env.GITLAB_TOKEN != null) {
        logger.info("GITLAB_BASE_URL set - using GitLabApp", { extra: { baseUrl: env.GITLAB_BASE_URL } });
        const config: ConstructorParameters<typeof GitLabApp>[0] = {
            baseUrl: env.GITLAB_BASE_URL,
            token: env.GITLAB_TOKEN,
        };
        if (env.GITLAB_WEBHOOK_SECRET != null) config.webhookSecret = env.GITLAB_WEBHOOK_SECRET;
        if (env.GITLAB_SLUG != null) config.slug = env.GITLAB_SLUG;
        return new GitLabApp(config);
    }

    const missing = getMissingGitHubCredentials(env);
    if (missing.length > 0) {
        throw new Error(
            `Missing GitHub app credentials: ${missing.join(", ")}. Set them, or set LOCAL_DEV=true to use the fake app.`,
        );
    }

    // Postgres-backed ETag store enables conditional requests (free 304s) on every GitHub call.
    const etagStore = new PrismaEtagStore(db);

    return new OctokitGitHubApp(
        {
            appId: env.GITHUB_APP_ID!,
            privateKey: env.GITHUB_APP_PRIVATE_KEY!,
            webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET!,
            appSlug: env.GITHUB_APP_SLUG!,
        },
        etagStore,
    );
}

function getMissingGitHubCredentials(env: ApiEnv): string[] {
    const missing: string[] = [];
    if (env.GITHUB_APP_ID == null) missing.push("GITHUB_APP_ID");
    if (env.GITHUB_APP_PRIVATE_KEY == null) missing.push("GITHUB_APP_PRIVATE_KEY");
    if (env.GITHUB_APP_WEBHOOK_SECRET == null) missing.push("GITHUB_APP_WEBHOOK_SECRET");
    if (env.GITHUB_APP_SLUG == null) missing.push("GITHUB_APP_SLUG");
    return missing;
}
