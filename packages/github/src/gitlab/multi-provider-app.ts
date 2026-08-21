import { logger } from "@autonoma/logger";
import type { GitHubApp, GitHubAppInstallation } from "../github-app";
import type { GitHubInstallationClient } from "../github-installation-client";
import { GitLabApp } from "./gitlab-app";

/** A stored GitLab connection, already decrypted by the host application. */
export interface GitLabConnection {
    baseUrl: string;
    token: string;
}

/**
 * Resolves an installation id to its GitLab connection, or undefined for
 * GitHub App installations. Hosts inject this so the class stays free of
 * database and crypto dependencies - the API resolves through Prisma plus its
 * encryption helper, workers through their own.
 */
export type GitLabConnectionResolver = (installationId: number) => Promise<GitLabConnection | undefined>;

/**
 * Routes {@link GitHubApp} calls to the right provider per installation:
 * GitHub App installations (positive ids) go to the fallback app, GitLab
 * connections (negative ids, stored per organization) each get a cached
 * {@link GitLabApp}. Everything downstream keeps talking to one interface and
 * never learns which host answered.
 */
export class MultiProviderApp implements GitHubApp {
    private readonly gitlabApps = new Map<number, GitLabApp>();

    constructor(
        private readonly fallback: GitHubApp,
        private readonly resolveConnection: GitLabConnectionResolver,
    ) {}

    get slug(): string {
        return this.fallback.slug;
    }

    async listInstallations(): Promise<GitHubAppInstallation[]> {
        return this.fallback.listInstallations();
    }

    async getInstallationClient(installationId: number): Promise<GitHubInstallationClient> {
        const gitlabApp = await this.gitlabAppFor(installationId);
        if (gitlabApp != null) return gitlabApp.getInstallationClient(installationId);
        return this.fallback.getInstallationClient(installationId);
    }

    async deleteInstallation(installationId: number): Promise<void> {
        const gitlabApp = await this.gitlabAppFor(installationId);
        if (gitlabApp != null) {
            // Token-based: nothing to uninstall remotely; the stored connection
            // is the disconnect, and the cache entry must not outlive it.
            this.gitlabApps.delete(installationId);
            return;
        }
        await this.fallback.deleteInstallation(installationId);
    }

    async verifyWebhook(body: string, signature: string): Promise<boolean> {
        // GitHub deliveries only; GitLab deliveries are verified per-connection
        // by the webhook route, which knows which connection's secret to check.
        return this.fallback.verifyWebhook(body, signature);
    }

    private async gitlabAppFor(installationId: number): Promise<GitLabApp | undefined> {
        const cached = this.gitlabApps.get(installationId);
        if (cached != null) return cached;

        const connection = await this.resolveConnection(installationId);
        if (connection == null) return undefined;

        logger.debug("Building GitLab app for connection", { extra: { installationId } });
        const app = new GitLabApp({ baseUrl: connection.baseUrl, token: connection.token });
        this.gitlabApps.set(installationId, app);
        return app;
    }
}
