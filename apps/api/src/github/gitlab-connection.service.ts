import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { GitLabApi, GitLabApiError, GitLabApp } from "@autonoma/github";
import { type Logger, logger } from "@autonoma/logger";
import type { EncryptionHelper } from "@autonoma/scenario";

/** Avatar lookups are stable data; an hour of caching spares GitLab a request per author per page view. */
const AVATAR_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * The connect probe fails for exactly three human reasons - wrong address,
 * rejected token, or a token that cannot see anything - and the message names
 * which one, because "fetch failed" sends people to the wrong field.
 */
function describeProbeFailure(baseUrl: string, error: unknown): string {
    if (error instanceof GitLabApiError) {
        if (error.status === 401) {
            return "GitLab rejected the access token. Check it was copied in full, has the `api` scope, and has not expired or been revoked.";
        }
        if (error.status === 403) {
            return "GitLab refused the request with this token. It may lack the `api` scope, or the account may be blocked on the instance.";
        }
        return `${baseUrl} answered, but not like a GitLab API (HTTP ${error.status}). Check the URL points at the instance itself, not a group or project page.`;
    }
    return `Could not reach ${baseUrl}. Check the address, and that this Autonoma server can reach your GitLab instance over the network.`;
}

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
        // not on the first repository read - and fail in words the person who
        // typed the URL can act on, not a raw fetch error.
        const probe = new GitLabApp({ baseUrl: normalizedBaseUrl, token });
        let installations;
        try {
            installations = await probe.listInstallations();
        } catch (error) {
            throw new Error(describeProbeFailure(normalizedBaseUrl, error), { cause: error });
        }
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

    /**
     * Resolve author logins to avatar URLs through whatever provider the org
     * is connected to. GitHub logins map straight to github.com's public
     * avatar endpoint; GitLab has no public avatar-by-username URL, so logins
     * are looked up through the connection's token (the avatar_url GitLab
     * returns - an upload or a gravatar - is itself publicly fetchable).
     * Unknown logins resolve to null and the UI falls back to initials.
     */
    async resolveAuthorAvatars(organizationId: string, logins: string[]): Promise<Record<string, string | null>> {
        const unique = [...new Set(logins)];
        const result: Record<string, string | null> = {};

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId },
            select: { provider: true, providerBaseUrl: true, providerTokenEnc: true },
        });

        if (installation?.provider !== "gitlab") {
            for (const login of unique) {
                result[login] = `https://github.com/${encodeURIComponent(login)}.png?size=48`;
            }
            return result;
        }

        if (installation.providerBaseUrl == null || installation.providerTokenEnc == null) {
            for (const login of unique) result[login] = null;
            return result;
        }

        const api = new GitLabApi({
            baseUrl: installation.providerBaseUrl,
            token: this.encryption.decrypt(installation.providerTokenEnc),
        });

        for (const login of unique) {
            const cacheKey = `${organizationId}:${login}`;
            const cached = this.avatarCache.get(cacheKey);
            if (cached != null && cached.expiresAt > Date.now()) {
                result[login] = cached.url;
                continue;
            }
            let url: string | null = null;
            try {
                const users = await api.request<Array<{ avatar_url?: string | null }>>("/users", {
                    query: { username: login },
                });
                url = users[0]?.avatar_url ?? null;
            } catch (error) {
                this.logger.warn("Avatar lookup failed; falling back to initials", {
                    organizationId,
                    extra: { login, error: String(error) },
                });
            }
            this.avatarCache.set(cacheKey, { url, expiresAt: Date.now() + AVATAR_CACHE_TTL_MS });
            result[login] = url;
        }
        return result;
    }

    private readonly avatarCache = new Map<string, { url: string | null; expiresAt: number }>();

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
