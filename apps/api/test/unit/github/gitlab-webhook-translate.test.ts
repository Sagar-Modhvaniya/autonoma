import { describe, expect, it } from "vitest";
import { translateGitLabWebhook } from "../../../src/github/gitlab-webhook-translate";

const project = {
    id: 42,
    name: "web",
    path_with_namespace: "acme/web",
    default_branch: "main",
    git_http_url: "https://gitlab.example.com/acme/web.git",
};

function mergeRequestEvent(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        object_kind: "merge_request",
        user: { username: "alice" },
        project,
        object_attributes: {
            iid: 7,
            title: "Add login page",
            description: "MR body",
            state: "opened",
            action: "open",
            source_branch: "feat/login",
            target_branch: "main",
            last_commit: { id: "head1234" },
            url: "https://gitlab.example.com/acme/web/-/merge_requests/7",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            ...overrides,
        },
    };
}

describe("translateGitLabWebhook", () => {
    it("translates an opened merge request into pull_request.opened", () => {
        const translated = translateGitLabWebhook("Merge Request Hook", mergeRequestEvent({}));

        expect(translated?.eventKey).toBe("pull_request.opened");
        expect(translated?.payload).toMatchObject({
            action: "opened",
            installation: { id: 1 },
            repository: {
                id: 42,
                full_name: "acme/web",
                default_branch: "main",
                clone_url: "https://gitlab.example.com/acme/web.git",
            },
            pull_request: {
                number: 7,
                title: "Add login page",
                state: "open",
                merged: false,
                user: { login: "alice" },
                head: { ref: "feat/login", sha: "head1234" },
                base: { ref: "main" },
            },
        });
    });

    it("translates a merge action into a closed-and-merged pull request", () => {
        const translated = translateGitLabWebhook(
            "Merge Request Hook",
            mergeRequestEvent({ action: "merge", state: "merged", merge_commit_sha: "cafe1234" }),
        );

        expect(translated?.eventKey).toBe("pull_request.closed");
        expect(translated?.payload).toMatchObject({
            pull_request: { state: "closed", merged: true, merge_commit_sha: "cafe1234" },
        });
    });

    it("maps update to synchronize only when new commits arrived", () => {
        const withCommits = translateGitLabWebhook(
            "Merge Request Hook",
            mergeRequestEvent({ action: "update", oldrev: "old1234" }),
        );
        expect(withCommits?.eventKey).toBe("pull_request.synchronize");

        const titleOnly = translateGitLabWebhook("Merge Request Hook", mergeRequestEvent({ action: "update" }));
        expect(titleOnly).toBeUndefined();
    });

    it("translates push hooks", () => {
        const translated = translateGitLabWebhook("Push Hook", {
            object_kind: "push",
            ref: "refs/heads/main",
            before: "old1234",
            after: "new1234",
            project,
        });

        expect(translated?.eventKey).toBe("push");
        expect(translated?.payload).toMatchObject({
            ref: "refs/heads/main",
            after: "new1234",
            repository: { id: 42, full_name: "acme/web" },
        });
    });

    it("ignores events it does not model", () => {
        expect(translateGitLabWebhook("Pipeline Hook", { object_kind: "pipeline" })).toBeUndefined();
        expect(translateGitLabWebhook("Merge Request Hook", { object_kind: "merge_request" })).toBeUndefined();
    });
});
