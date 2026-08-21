import { GITLAB_INSTALLATION_ID } from "@autonoma/github";
import { z } from "zod";

/**
 * Translates GitLab webhook deliveries into the GitHub-shaped events the
 * webhook pipeline already dispatches on, so every downstream consumer
 * (PR cache, preview deploys, merge gate, contributors) stays provider-agnostic.
 *
 * Supported: `Merge Request Hook` (open / reopen / close / merge / update-with-
 * new-commits) and `Push Hook`. Everything else translates to `undefined` and
 * is acknowledged-but-ignored, mirroring how unmodeled GitHub events are handled.
 */
export interface TranslatedGitLabEvent {
    /** Key into the GitHub webhook event map, e.g. `pull_request.opened`. */
    eventKey: string;
    /** GitHub-shaped payload the existing dispatchers can parse. */
    payload: Record<string, unknown>;
}

const gitlabProjectSchema = z.object({
    id: z.number(),
    name: z.string().optional(),
    path_with_namespace: z.string(),
    default_branch: z.string().optional(),
    git_http_url: z.string().optional(),
    web_url: z.string().optional(),
});

const gitlabMergeRequestEventSchema = z.object({
    object_kind: z.literal("merge_request"),
    user: z.object({ username: z.string().optional() }).optional(),
    project: gitlabProjectSchema,
    object_attributes: z.object({
        iid: z.number(),
        title: z.string(),
        description: z.string().nullish(),
        state: z.string(),
        action: z.string().optional(),
        source_branch: z.string(),
        target_branch: z.string(),
        last_commit: z.object({ id: z.string() }).optional(),
        url: z.string().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
        merge_commit_sha: z.string().nullish(),
        oldrev: z.string().optional(),
    }),
});

const gitlabPushEventSchema = z.object({
    object_kind: z.literal("push"),
    ref: z.string(),
    before: z.string().optional(),
    after: z.string().optional(),
    project: gitlabProjectSchema,
});

/** GitLab MR actions mapped onto GitHub pull_request actions; absent = ignore. */
function mergeRequestActionToGitHub(action: string | undefined, hasNewCommits: boolean): string | undefined {
    if (action === "open") return "opened";
    if (action === "reopen") return "reopened";
    if (action === "close" || action === "merge") return "closed";
    // GitLab fires `update` for every MR edit; only new commits (oldrev set)
    // correspond to GitHub's `synchronize`.
    if (action === "update" && hasNewCommits) return "synchronize";
    return undefined;
}

export function translateGitLabWebhook(
    event: string,
    payload: unknown,
    installationId: number = GITLAB_INSTALLATION_ID,
): TranslatedGitLabEvent | undefined {
    if (event === "Merge Request Hook") return translateMergeRequestEvent(payload, installationId);
    if (event === "Push Hook") return translatePushEvent(payload, installationId);
    return undefined;
}

function translateMergeRequestEvent(payload: unknown, installationId: number): TranslatedGitLabEvent | undefined {
    const parsed = gitlabMergeRequestEventSchema.safeParse(payload);
    if (!parsed.success) return undefined;

    const { project, object_attributes: mr, user } = parsed.data;
    const action = mergeRequestActionToGitHub(mr.action, mr.oldrev != null);
    if (action == null) return undefined;

    const merged = mr.state === "merged" || mr.action === "merge";
    const repository = toGitHubRepository(project);
    const headSha = mr.last_commit?.id ?? "";
    const now = new Date().toISOString();

    return {
        eventKey: `pull_request.${action}`,
        payload: {
            action,
            installation: { id: installationId },
            repository,
            pull_request: {
                number: mr.iid,
                title: mr.title,
                body: mr.description ?? "",
                state: merged || mr.state === "closed" ? "closed" : "open",
                merged,
                merge_commit_sha: mr.merge_commit_sha ?? null,
                draft: false,
                user: { login: user?.username ?? "" },
                html_url: mr.url ?? "",
                created_at: mr.created_at ?? now,
                updated_at: mr.updated_at ?? now,
                head: {
                    ref: mr.source_branch,
                    sha: headSha,
                    repo: repository,
                },
                base: {
                    ref: mr.target_branch,
                    sha: "",
                    repo: repository,
                },
            },
        },
    };
}

function translatePushEvent(payload: unknown, installationId: number): TranslatedGitLabEvent | undefined {
    const parsed = gitlabPushEventSchema.safeParse(payload);
    if (!parsed.success) return undefined;

    const { project } = parsed.data;
    return {
        eventKey: "push",
        payload: {
            ref: parsed.data.ref,
            before: parsed.data.before ?? "",
            after: parsed.data.after ?? "",
            installation: { id: installationId },
            repository: toGitHubRepository(project),
        },
    };
}

function toGitHubRepository(project: z.infer<typeof gitlabProjectSchema>): Record<string, unknown> {
    const owner = project.path_with_namespace.split("/")[0] ?? "";
    return {
        id: project.id,
        name: project.name ?? project.path_with_namespace.split("/").pop() ?? "",
        full_name: project.path_with_namespace,
        default_branch: project.default_branch ?? "main",
        // Preview deploys clone through this; GitLab names it git_http_url.
        clone_url: project.git_http_url ?? (project.web_url != null ? `${project.web_url}.git` : ""),
        owner: { login: owner },
    };
}
