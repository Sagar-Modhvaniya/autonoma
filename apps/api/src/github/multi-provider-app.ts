import type { PrismaClient } from "@autonoma/db";
import { type GitHubApp, type GitHubAppInstallation, GitLabApp } from "@autonoma/github";
import type { GitHubInstallationClient } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { EncryptionHelper } from "@autonoma/scenario";

/**
 * Routes {@link GitHubApp} calls to the right provider per installation.
 *
 * GitHub App installations (positive ids, created by the install callback) go
 * to the server-wide fallback app. GitLab connections are per-organization
 * database rows (provider=gitlab, negative ids, created by `gitlab.connect`)
 * carrying their own instance URL and encrypted token; each gets a cached
 * {@link GitLabApp}. Everything downstream - the installation service, PR
 * cache, preview triggers - keeps talking to one interface and never learns
 * which host answered.
 */
export class MultiProviderApp implements GitHubApp {
    private readonly gitlabApps = new Map<number, GitLabApp>();

    constructor(
        private readonly db: PrismaClient,
        private readonly fallback: GitHubApp,
        private readonly encryption: EncryptionHelper,
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
            // Token-based: nothing to uninstall remotely; the row deletion is
            // the disconnect, and the cache entry must not outlive it.
            this.gitlabApps.delete(installationId);
            return;
        }
        await this.fallback.deleteInstallation(installationId);
    }

    async verifyWebhook(body: string, signature: string): Promise<boolean> {
        // GitHub deliveries only; GitLab deliveries are verified per-connection
        // in the gitlab webhook route, which knows which row's secret to check.
        return this.fallback.verifyWebhook(body, signature);
    }

    /** The cached GitLab app for a connection row, or undefined for GitHub installations. */
    private async gitlabAppFor(installationId: number): Promise<GitLabApp | undefined> {
        const cached = this.gitlabApps.get(installationId);
        if (cached != null) return cached;

        const row = await this.db.gitHubInstallation.findUnique({
            where: { installationId },
            select: { provider: true, providerBaseUrl: true, providerTokenEnc: true },
        });
        if (row == null || row.provider !== "gitlab") return undefined;
        if (row.providerBaseUrl == null || row.providerTokenEnc == null) {
            logger.warn("GitLab connection row missing base URL or token", { extra: { installationId } });
            return undefined;
        }

        const app = new GitLabApp({
            baseUrl: row.providerBaseUrl,
            token: this.encryption.decrypt(row.providerTokenEnc),
        });
        this.gitlabApps.set(installationId, app);
        return app;
    }
}
