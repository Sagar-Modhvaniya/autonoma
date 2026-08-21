import { type Logger, logger } from "@autonoma/logger";

/**
 * Minimal typed client for the GitLab REST API v4.
 *
 * Works against gitlab.com and self-managed instances alike: `baseUrl` is the
 * instance origin (e.g. `https://gitlab.example.com`) and every request is
 * authenticated with a project/group/personal access token via the
 * `PRIVATE-TOKEN` header, which GitLab accepts for all token kinds.
 */
export interface GitLabApiConfig {
    /** Instance origin, no trailing slash and no `/api/v4` suffix. */
    baseUrl: string;
    /** Personal, group, or project access token with `api` scope. */
    token: string;
}

export class GitLabApiError extends Error {
    constructor(
        readonly status: number,
        readonly path: string,
        message: string,
    ) {
        super(`GitLab API ${status} on ${path}: ${message}`);
        this.name = "GitLabApiError";
    }
}

interface RequestOptions {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
}

export class GitLabApi {
    private readonly logger: Logger;

    constructor(private readonly config: GitLabApiConfig) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    get baseUrl(): string {
        return this.config.baseUrl;
    }

    get token(): string {
        return this.config.token;
    }

    /** JSON request against `/api/v4`. Returns the parsed body; `undefined` for 404 when `tolerate404` is set. */
    async request<T>(path: string, options: RequestOptions & { tolerate404: true }): Promise<T | undefined>;
    async request<T>(path: string, options?: RequestOptions): Promise<T>;
    async request<T>(
        path: string,
        options: RequestOptions & { tolerate404?: boolean } = {},
    ): Promise<T | undefined> {
        const response = await this.raw(path, options);
        if (response.status === 404 && options.tolerate404 === true) {
            return undefined;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new GitLabApiError(response.status, path, text.slice(0, 500));
        }
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
    }

    /** Raw response, for callers that need headers (pagination) or non-JSON bodies. */
    async raw(path: string, options: RequestOptions = {}): Promise<Response> {
        const url = new URL(`${this.config.baseUrl}/api/v4${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value != null) url.searchParams.set(key, String(value));
        }
        const headers: Record<string, string> = { "PRIVATE-TOKEN": this.config.token };
        let body: string | undefined;
        if (options.body != null) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(options.body);
        }
        this.logger.debug("GitLab API request", { extra: { method: options.method ?? "GET", path } });
        return fetch(url, { method: options.method ?? "GET", headers, body });
    }

    /**
     * Fetch every page of a list endpoint, following GitLab's `x-next-page`
     * header, capped at `maxPages` to bound very large result sets. Returns the
     * collected items plus whether the cap truncated the listing.
     */
    async paginate<T>(
        path: string,
        query: Record<string, string | number | boolean | undefined> = {},
        maxPages = 10,
    ): Promise<{ items: T[]; truncated: boolean }> {
        const items: T[] = [];
        let page = 1;
        while (page <= maxPages) {
            const response = await this.raw(path, { query: { ...query, per_page: 100, page } });
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new GitLabApiError(response.status, path, text.slice(0, 500));
            }
            const batch = (await response.json()) as T[];
            items.push(...batch);
            const nextPage = response.headers.get("x-next-page");
            if (nextPage == null || nextPage === "") return { items, truncated: false };
            page = Number(nextPage);
        }
        return { items, truncated: true };
    }
}

/** URL-encodes a `namespace/project` path for use as a GitLab project id segment. */
export function encodeProjectPath(fullName: string): string {
    return encodeURIComponent(fullName);
}
