import { timingSafeEqual } from "node:crypto";
import { type Logger, logger } from "@autonoma/logger";
import type { GitHubApp, GitHubAppInstallation } from "../github-app";
import type { GitHubInstallationClient } from "../github-installation-client";
import { GitLabApi } from "./gitlab-api";
import { GitLabInstallationClient } from "./gitlab-installation-client";

/**
 * The synthetic installation id every GitLab connection reports. GitLab has no
 * GitHub-App-style installation object: access is a single token scoped to a
 * user, group, or project, so one configured connection is one "installation".
 */
export const GITLAB_INSTALLATION_ID = 1;

export interface GitLabAppConfig {
    /** Instance origin, e.g. `https://gitlab.com` or a self-managed host. */
    baseUrl: string;
    /** Personal, group, or project access token with `api` scope. */
    token: string;
    /**
     * Shared secret GitLab webhooks are configured with. GitLab sends it back
     * verbatim in `X-Gitlab-Token` (no HMAC), so verification is an equality
     * check.
     */
    webhookSecret?: string;
    /** Display slug; surfaces wherever the GitHub App slug would. */
    slug?: string;
}

/**
 * {@link GitHubApp} implementation backed by a GitLab instance. Selected by the
 * API server when `GITLAB_BASE_URL` + `GITLAB_TOKEN` are configured, giving
 * self-hosted deployments the same repo/MR loop without a GitHub account.
 */
export class GitLabApp implements GitHubApp {
    public readonly slug: string;
    private readonly api: GitLabApi;
    private readonly client: GitLabInstallationClient;
    private readonly logger: Logger;

    constructor(private readonly config: GitLabAppConfig) {
        this.slug = config.slug ?? "gitlab";
        this.api = new GitLabApi({ baseUrl: config.baseUrl, token: config.token });
        this.client = new GitLabInstallationClient(this.api);
        this.logger = logger.child({ name: this.constructor.name });
        this.logger.info("Initialized GitLab app", { extra: { baseUrl: config.baseUrl, slug: this.slug } });
    }

    async listInstallations(): Promise<GitHubAppInstallation[]> {
        const user = await this.api.request<{ username?: string }>("/user");
        return [
            {
                id: GITLAB_INSTALLATION_ID,
                accountLogin: user.username ?? "gitlab",
                accountType: "Organization",
            },
        ];
    }

    async getInstallationClient(_installationId: number): Promise<GitHubInstallationClient> {
        return this.client;
    }

    async deleteInstallation(installationId: number): Promise<void> {
        // Token-based: there is nothing to uninstall on the GitLab side.
        this.logger.info("GitLab deleteInstallation is a no-op", { extra: { installationId } });
    }

    async verifyWebhook(_body: string, signature: string): Promise<boolean> {
        const secret = this.config.webhookSecret;
        if (secret == null || secret.length === 0) return false;
        const provided = Buffer.from(signature);
        const expected = Buffer.from(secret);
        if (provided.length !== expected.length) return false;
        return timingSafeEqual(provided, expected);
    }
}
