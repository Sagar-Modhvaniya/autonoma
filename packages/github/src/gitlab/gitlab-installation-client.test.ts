import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabApi } from "./gitlab-api";
import { GitLabApp } from "./gitlab-app";
import { GitLabInstallationClient } from "./gitlab-installation-client";

const BASE_URL = "https://gitlab.example.com";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
    });
}

function clientWithFetch(fetchMock: typeof fetch): GitLabInstallationClient {
    vi.stubGlobal("fetch", fetchMock);
    return new GitLabInstallationClient(new GitLabApi({ baseUrl: BASE_URL, token: "glpat-test" }));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("GitLabInstallationClient", () => {
    it("maps a merged merge request onto the PullRequest shape", async () => {
        const mr = {
            iid: 7,
            title: "Add login page",
            description: "MR body",
            source_branch: "feat/login",
            target_branch: "main",
            state: "merged",
            web_url: `${BASE_URL}/acme/web/-/merge_requests/7`,
            author: { username: "alice" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            merged_at: "2026-01-02T00:00:00Z",
            merge_commit_sha: "cafe1234",
            squash: false,
            diff_refs: { base_sha: "base1234", head_sha: "head1234" },
        };
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/merge_requests/7/commits")) return jsonResponse([{ id: "head1234" }]);
            return jsonResponse(mr);
        });
        const client = clientWithFetch(fetchMock as typeof fetch);

        const pr = await client.getPullRequest(42, 7);

        expect(pr).toMatchObject({
            number: 7,
            title: "Add login page",
            body: "MR body",
            headRef: "feat/login",
            headSha: "head1234",
            baseRef: "main",
            baseSha: "base1234",
            authorLogin: "alice",
            state: "merged",
            merged: true,
            mergeMethod: "merge",
            mergeCommitSha: "cafe1234",
            commitsCount: 1,
        });
    });

    it("round-trips comment ids as mrIid::noteId so updates stay MR-scoped", async () => {
        const requests: Array<{ url: string; method: string | undefined }> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(input), method: init?.method });
            return jsonResponse({ id: 99, body: "marker" });
        });
        const client = clientWithFetch(fetchMock as typeof fetch);

        const commentId = await client.postComment("acme/web", 7, "marker");
        expect(commentId).toBe("7::99");

        await client.updateComment("acme/web", commentId, "updated");
        const updateRequest = requests[1];
        expect(updateRequest?.method).toBe("PUT");
        expect(updateRequest?.url).toContain("/projects/acme%2Fweb/merge_requests/7/notes/99");
    });

    it("posts commit statuses for check runs and re-posts on update via the sha::context id", async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
            return jsonResponse({});
        });
        const client = clientWithFetch(fetchMock as typeof fetch);

        const checkRunId = await client.createCheckRun({
            repoFullName: "acme/web",
            headSha: "head1234",
            name: "Autonoma",
            status: "in_progress",
            title: "Running tests",
            summary: "…",
        });
        expect(checkRunId).toBe("head1234::Autonoma");
        expect(bodies[0]).toMatchObject({ state: "running", context: "Autonoma" });

        await client.updateCheckRun({
            repoFullName: "acme/web",
            checkRunId,
            status: "completed",
            conclusion: "success",
            title: "All green",
            summary: "…",
        });
        expect(bodies[1]).toMatchObject({ state: "success", context: "Autonoma" });
    });

    it("collapses GitLab access levels onto collaborator permissions", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/users?")) return jsonResponse([{ id: 5 }]);
            return jsonResponse({ access_level: 30 });
        });
        const client = clientWithFetch(fetchMock as typeof fetch);

        await expect(client.getRepoCollaboratorPermission("acme/web", "bob")).resolves.toBe("write");
    });
});

describe("GitLabApp", () => {
    it("verifies webhooks by comparing the X-Gitlab-Token secret", async () => {
        const app = new GitLabApp({ baseUrl: BASE_URL, token: "glpat-test", webhookSecret: "hook-secret" });

        await expect(app.verifyWebhook("{}", "hook-secret")).resolves.toBe(true);
        await expect(app.verifyWebhook("{}", "wrong")).resolves.toBe(false);
    });

    it("reports a single synthetic installation for the configured token", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse({ username: "artha-bot" })),
        );
        const app = new GitLabApp({ baseUrl: BASE_URL, token: "glpat-test" });

        await expect(app.listInstallations()).resolves.toEqual([
            { id: 1, accountLogin: "artha-bot", accountType: "Organization" },
        ]);
    });
});
