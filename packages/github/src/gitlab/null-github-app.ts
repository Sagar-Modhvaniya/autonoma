import type { GitHubApp, GitHubAppInstallation } from "../github-app";
import type { GitHubInstallationClient } from "../github-installation-client";

/**
 * The base app for a server configured with no env-level git provider at all:
 * every organization connects its own provider (today: GitLab) through the UI,
 * and those connections resolve per installation before this fallback is ever
 * consulted. Reaching it means an installation has no stored connection - the
 * error says exactly that instead of failing the whole boot.
 */
export class NullGitHubApp implements GitHubApp {
    readonly slug = "unconfigured";

    async listInstallations(): Promise<GitHubAppInstallation[]> {
        return [];
    }

    async getInstallationClient(installationId: number): Promise<GitHubInstallationClient> {
        throw new Error(
            `Installation ${installationId} has no stored provider connection, and this server has no ` +
                "env-configured git provider to fall back to. Connect GitHub or GitLab for the workspace, " +
                "or configure GITHUB_APP_* / GITLAB_* on the server.",
        );
    }

    async deleteInstallation(): Promise<void> {}

    async verifyWebhook(): Promise<boolean> {
        return false;
    }
}
