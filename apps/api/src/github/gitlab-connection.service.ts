import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { GitLabApp } from "@autonoma/github";
import { type Logger, logger } from "@autonoma/logger";
import type { EncryptionHelper } from "@autonoma/scenario";

export interface ConnectGitLabResult {
    installationId: number;
    accountLogin: string;
    /** Shown once so the user can configure the GitLab webhook with it. */
    webhookSecret: string;
    webhookPath: string;
}

/**
 * Per-organization GitLab connections, the counterpart of the GitHub App
 * install flow. A connection is a `github_installation` row with
 * provider=gitlab: instance URL + encrypted API token + the webhook secret
 * incoming deliveries are matched against. Installation ids are allocated
 * NEGATIVE so they can never collide with GitHub App installation ids.
 */
export class GitLabConnectionService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly encryption: EncryptionHelper,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async connect(organizationId: string, baseUrl: string, token: string): Promise<ConnectGitLabResult> {
        const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

        // Probe before storing anything: a bad URL or token should fail here,
        // not on the first repository read.
        const probe = new GitLabApp({ baseUrl: normalizedBaseUrl, token });
        const installations = await probe.listInstallations();
        const accountLogin = installations[0]?.accountLogin ?? "gitlab";

        const existing = await this.db.gitHubInstallation.findUnique({
            where: { organizationId },
            select: { provider: true, accountLogin: true },
        });
        if (existing != null && existing.provider !== "gitlab") {
            throw new Error(
                `This workspace is connected to GitHub (${existing.accountLogin}). ` +
                    "Disconnect the GitHub App before connecting GitLab.",
            );
        }

        const webhookSecret = randomBytes(24).toString("hex");
        const installationId = existing != null ? undefined : await this.allocateInstallationId();

        this.logger.info("Connecting GitLab", {
            organizationId,
            extra: { baseUrl: normalizedBaseUrl, accountLogin },
        });

        const row = await this.db.gitHubInstallation.upsert({
            where: { organizationId },
            create: {
                installationId: installationId ?? -1,
                organizationId,
                accountLogin,
                accountId: 0,
                accountType: "Organization",
                status: "active",
                provider: "gitlab",
                providerBaseUrl: normalizedBaseUrl,
                providerTokenEnc: this.encryption.encrypt(token),
                webhookSecretEnc: this.encryption.encrypt(webhookSecret),
            },
            update: {
                accountLogin,
                status: "active",
                provider: "gitlab",
                providerBaseUrl: normalizedBaseUrl,
                providerTokenEnc: this.encryption.encrypt(token),
                webhookSecretEnc: this.encryption.encrypt(webhookSecret),
            },
        });

        return {
            installationId: row.installationId,
            accountLogin,
            webhookSecret,
            webhookPath: "/v1/github/gitlab-webhook",
        };
    }

    async disconnect(organizationId: string): Promise<void> {
        const existing = await this.db.gitHubInstallation.findUnique({
            where: { organizationId },
            select: { provider: true },
        });
        if (existing?.provider !== "gitlab") return;
        this.logger.info("Disconnecting GitLab", { organizationId });
        await this.db.gitHubInstallation.delete({ where: { organizationId } });
    }

    /**
     * Resolves an incoming delivery's `X-Gitlab-Token` to the connection it
     * belongs to, comparing against every stored secret in constant time.
     * Returns undefined when no connection matches (including env-configured
     * setups, which the caller verifies against the base app instead).
     */
    async findConnectionByWebhookToken(
        token: string,
    ): Promise<{ organizationId: string; installationId: number } | undefined> {
        if (token.length === 0) return undefined;
        const rows = await this.db.gitHubInstallation.findMany({
            where: { provider: "gitlab", webhookSecretEnc: { not: null } },
            select: { organizationId: true, installationId: true, webhookSecretEnc: true },
        });
        const provided = Buffer.from(token);
        for (const row of rows) {
            const secret = Buffer.from(this.encryption.decrypt(row.webhookSecretEnc as string));
            if (provided.length === secret.length && timingSafeEqual(provided, secret)) {
                return { organizationId: row.organizationId, installationId: row.installationId };
            }
        }
        return undefined;
    }

    /** Next free negative installation id. */
    private async allocateInstallationId(): Promise<number> {
        const lowest = await this.db.gitHubInstallation.findFirst({
            where: { installationId: { lt: 0 } },
            orderBy: { installationId: "asc" },
            select: { installationId: true },
        });
        return (lowest?.installationId ?? 0) - 1;
    }
}
