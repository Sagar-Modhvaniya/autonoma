import { db } from "@autonoma/db";
import {
    type GitHubApp,
    GitLabApp,
    MultiProviderApp,
    OctokitGitHubApp,
} from "@autonoma/github";
import { EncryptionHelper } from "@autonoma/scenario";
import { env } from "./env";

/**
 * The provider app this worker's activities read repositories through: the
 * env-configured base (GitHub App, or a GitLab instance) wrapped so
 * per-organization GitLab connections stored in the database resolve to their
 * own instances - the same layering the API server uses.
 */
export function createGithubApp(): GitHubApp {
    return new MultiProviderApp(createBaseApp(), async (installationId) => {
        if (env.SCENARIO_ENCRYPTION_KEY == null) return undefined;
        const row = await db.gitHubInstallation.findUnique({
            where: { installationId },
            select: { provider: true, providerBaseUrl: true, providerTokenEnc: true },
        });
        if (row?.provider !== "gitlab" || row.providerBaseUrl == null || row.providerTokenEnc == null) {
            return undefined;
        }
        const encryption = new EncryptionHelper(env.SCENARIO_ENCRYPTION_KEY);
        return { baseUrl: row.providerBaseUrl, token: encryption.decrypt(row.providerTokenEnc) };
    });
}

function createBaseApp(): GitHubApp {
    if (env.GITHUB_APP_ID != null && env.GITHUB_APP_PRIVATE_KEY != null) {
        return new OctokitGitHubApp({
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET ?? "",
            appSlug: env.GITHUB_APP_SLUG ?? "autonoma",
        });
    }
    if (env.GITLAB_BASE_URL != null && env.GITLAB_TOKEN != null) {
        return new GitLabApp({ baseUrl: env.GITLAB_BASE_URL, token: env.GITLAB_TOKEN });
    }
    throw new Error(
        "No git provider configured: set GITHUB_APP_* for a GitHub App, or GITLAB_BASE_URL + GITLAB_TOKEN for GitLab.",
    );
}
