import { type Logger, logger } from "@autonoma/logger";
import { buildAuthenticatedGitEnv, runGitStep } from "../git-clone-step";
import type {
    BranchList,
    BranchProtectionResult,
    CheckRunConclusion,
    CheckRunStatus,
    CloneRepositoryParams,
    Commit,
    CreateCheckRunParams,
    GitHubInstallationClient,
    GitTree,
    IssueComment,
    ListPullRequestsResult,
    PullRequest,
    PullRequestCommit,
    PullRequestState,
    RepoCollaboratorPermission,
    Repository,
    RequiredCheckRulesetParams,
    UpdateCheckRunParams,
} from "../github-installation-client";
import { encodeProjectPath, type GitLabApi } from "./gitlab-api";

// More generous than the GitHub client's budgets: github.com's bandwidth is a
// floor self-managed GitLab instances routinely sit far below (measured ~5min
// for a 171MB depth-50 clone from a modest VM).
const CLONE_TIMEOUT_MS = 600_000;
const FETCH_TIMEOUT_MS = 300_000;
const CHECKOUT_TIMEOUT_MS = 60_000;
const CLONE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Default color for a label the app auto-creates, mirroring the GitHub client. */
const DEFAULT_LABEL_COLOR = "#0e8a16";

interface GitLabProject {
    id: number;
    path: string;
    path_with_namespace: string;
    default_branch?: string;
    visibility?: string;
}

interface GitLabMergeRequest {
    iid: number;
    title: string;
    description?: string;
    source_branch: string;
    target_branch: string;
    sha?: string;
    state: string;
    web_url: string;
    author?: { username?: string };
    created_at: string;
    updated_at: string;
    merged_at?: string;
    merge_commit_sha?: string;
    squash_commit_sha?: string;
    squash?: boolean;
    diff_refs?: { base_sha?: string; head_sha?: string };
}

interface GitLabCommit {
    id: string;
    message?: string;
    title?: string;
    author_name?: string;
    author_email?: string;
    authored_date?: string;
    created_at?: string;
    parent_ids?: string[];
}

interface GitLabNote {
    id: number;
    body: string;
    system?: boolean;
}

/**
 * {@link GitHubInstallationClient} backed by the GitLab REST API v4.
 *
 * Concept mapping: a GitLab *project* is a repository (`repoId` = the numeric
 * project id, `fullName` = `path_with_namespace`); a *merge request* is a pull
 * request (`number` = the MR `iid`); MR *notes* are issue comments; *commit
 * statuses* stand in for check runs (GitLab has no per-run UI object, so the
 * "check run id" round-trips as `<sha>::<context>` and updates re-post the
 * status for that pair).
 */
export class GitLabInstallationClient implements GitHubInstallationClient {
    private readonly logger: Logger;

    constructor(private readonly api: GitLabApi) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async getInstallation(_installationId: number): Promise<{ account: unknown; createdAt: string }> {
        const user = await this.api.request<{ username?: string; name?: string }>("/user");
        // GitLab connections are token-based: there is no install event whose
        // recency needs proving, so the connection always reads as fresh.
        return {
            account: { login: user.username ?? "gitlab", type: "Organization" },
            createdAt: new Date().toISOString(),
        };
    }

    async getInstallationToken(): Promise<string> {
        return this.api.token;
    }

    async cloneRepository(params: CloneRepositoryParams): Promise<string> {
        const { fullName, headSha, targetDir, depth = 50 } = params;

        // Same env-based credential passing as the GitHub client: the token is
        // never in argv, the stored remote, or git's stderr. GitLab accepts the
        // basic-auth form for personal/group/project access tokens alike.
        const token = this.api.token;
        const gitEnv = buildAuthenticatedGitEnv(token);
        const cloneUrl = `${this.api.baseUrl}/${fullName}.git`;

        this.logger.info("Cloning GitLab repository", { extra: { fullName, headSha, targetDir } });
        await runGitStep(
            "clone",
            ["clone", `--depth=${depth}`, cloneUrl, targetDir],
            { timeoutMs: CLONE_TIMEOUT_MS, env: gitEnv, maxBufferBytes: CLONE_MAX_BUFFER_BYTES },
            token,
            this.logger,
        );

        try {
            await runGitStep(
                "checkout-head",
                ["checkout", headSha],
                { timeoutMs: CHECKOUT_TIMEOUT_MS, cwd: targetDir },
                token,
                this.logger,
            );
        } catch (err) {
            this.logger.info("Head SHA not in shallow clone, fetching explicitly", { extra: { headSha, err } });
            await runGitStep(
                "fetch-head",
                ["fetch", `--depth=${depth}`, "origin", headSha],
                { timeoutMs: FETCH_TIMEOUT_MS, cwd: targetDir, env: gitEnv },
                token,
                this.logger,
            );
            await runGitStep(
                "checkout-head",
                ["checkout", headSha],
                { timeoutMs: CHECKOUT_TIMEOUT_MS, cwd: targetDir },
                token,
                this.logger,
            );
        }
        return targetDir;
    }

    async getRepository(repoId: number): Promise<Repository> {
        const project = await this.api.request<GitLabProject>(`/projects/${repoId}`);
        return toRepository(project);
    }

    async getRepositoryArchiveUrl(repoId: number, ref?: string): Promise<string> {
        // GitLab's archive endpoint has no pre-signed variant, so the token
        // rides along as a query parameter - callers treat the URL as secret,
        // exactly as they must with GitHub's short-lived signed URLs.
        const sha = ref == null ? "" : `&sha=${encodeURIComponent(ref)}`;
        return `${this.api.baseUrl}/api/v4/projects/${repoId}/repository/archive.tar.gz?private_token=${this.api.token}${sha}`;
    }

    async listInstallationRepos(): Promise<Repository[]> {
        const { items } = await this.api.paginate<GitLabProject>("/projects", {
            membership: true,
            archived: false,
            order_by: "last_activity_at",
        });
        return items.map(toRepository);
    }

    async getPullRequest(repoId: number, prNumber: number): Promise<PullRequest> {
        const mr = await this.api.request<GitLabMergeRequest>(`/projects/${repoId}/merge_requests/${prNumber}`);
        const commits = await this.api.request<GitLabCommit[]>(
            `/projects/${repoId}/merge_requests/${prNumber}/commits`,
            { query: { per_page: 100 } },
        );
        return toPullRequest(mr, commits.length);
    }

    async listOpenPullRequests(repoId: number): Promise<ListPullRequestsResult> {
        const { items } = await this.api.paginate<GitLabMergeRequest>(`/projects/${repoId}/merge_requests`, {
            state: "opened",
        });
        return { unchanged: false, pullRequests: items.map((mr) => toPullRequest(mr, 0)) };
    }

    async listClosedPullRequests(repoId: number): Promise<ListPullRequestsResult> {
        const merged = await this.api.paginate<GitLabMergeRequest>(`/projects/${repoId}/merge_requests`, {
            state: "merged",
        });
        const closed = await this.api.paginate<GitLabMergeRequest>(`/projects/${repoId}/merge_requests`, {
            state: "closed",
        });
        const pullRequests = [...merged.items, ...closed.items].map((mr) => toPullRequest(mr, 0));
        return { unchanged: false, pullRequests };
    }

    async getAssociatedPullRequests(owner: string, repo: string, sha: string): Promise<PullRequest[]> {
        const projectPath = encodeProjectPath(`${owner}/${repo}`);
        const mrs = await this.api.request<GitLabMergeRequest[]>(
            `/projects/${projectPath}/repository/commits/${sha}/merge_requests`,
        );
        return mrs.map((mr) => toPullRequest(mr, 0));
    }

    async listPullRequestCommits(repoId: number, prNumber: number): Promise<PullRequestCommit[]> {
        const commits = await this.api.request<GitLabCommit[]>(
            `/projects/${repoId}/merge_requests/${prNumber}/commits`,
            { query: { per_page: 100 } },
        );
        return commits.map((commit) => ({
            sha: commit.id,
            message: commit.message ?? commit.title ?? "",
            authorLogin: commit.author_name,
            authoredAt: commit.authored_date ?? commit.created_at ?? new Date(0).toISOString(),
        }));
    }

    async getCommit(repoId: number, sha: string): Promise<Commit> {
        const commit = await this.api.request<GitLabCommit>(`/projects/${repoId}/repository/commits/${sha}`);
        const diff = await this.api.request<Array<{ new_path: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean }>>(
            `/projects/${repoId}/repository/commits/${sha}/diff`,
        );
        return {
            sha: commit.id,
            message: commit.message ?? commit.title ?? "",
            authorLogin: commit.author_name,
            // GitLab's diff endpoint reports no per-file counters; 0 keeps the
            // shape without inventing numbers.
            files: diff.map((file) => ({
                filename: file.new_path,
                status: file.new_file ? "added" : file.deleted_file ? "removed" : file.renamed_file ? "renamed" : "modified",
                additions: 0,
                deletions: 0,
            })),
            parents: commit.parent_ids ?? [],
        };
    }

    async getBranchHead(repoId: number, branchName: string): Promise<string> {
        const branch = await this.api.request<{ commit?: { id?: string } }>(
            `/projects/${repoId}/repository/branches/${encodeURIComponent(branchName)}`,
        );
        const sha = branch.commit?.id;
        if (sha == null) throw new Error(`Branch ${branchName} has no head commit`);
        return sha;
    }

    async listBranches(repoId: number): Promise<BranchList> {
        const response = await this.api.raw(`/projects/${repoId}/repository/branches`, {
            query: { per_page: 100 },
        });
        if (!response.ok) throw new Error(`GitLab branches request failed with ${response.status}`);
        const branches = (await response.json()) as Array<{ name: string }>;
        const nextPage = response.headers.get("x-next-page");
        return { names: branches.map((branch) => branch.name), truncated: nextPage != null && nextPage !== "" };
    }

    async getGitTree(repoId: number, ref: string): Promise<GitTree> {
        const { items, truncated } = await this.api.paginate<{ path: string; type: string }>(
            `/projects/${repoId}/repository/tree`,
            { recursive: true, ref },
            50,
        );
        return { paths: items.filter((entry) => entry.type === "blob").map((entry) => entry.path), truncated };
    }

    async getFileContent(repoId: number, path: string, ref: string): Promise<string | undefined> {
        const response = await this.api.raw(
            `/projects/${repoId}/repository/files/${encodeURIComponent(path)}/raw`,
            { query: { ref } },
        );
        if (response.status === 404) return undefined;
        if (!response.ok) throw new Error(`GitLab file request failed with ${response.status}`);
        return await response.text();
    }

    async listIssueComments(repoFullName: string, prNumber: number): Promise<IssueComment[]> {
        const projectPath = encodeProjectPath(repoFullName);
        const { items } = await this.api.paginate<GitLabNote>(
            `/projects/${projectPath}/merge_requests/${prNumber}/notes`,
        );
        // Ids are `<mrIid>::<noteId>`: note updates/deletes are MR-scoped on
        // GitLab, and callers round-trip whatever id these methods return.
        return items
            .filter((note) => note.system !== true)
            .map((note) => ({ id: `${prNumber}::${note.id}`, body: note.body }));
    }

    async postComment(repoFullName: string, prNumber: number, body: string): Promise<string> {
        const projectPath = encodeProjectPath(repoFullName);
        const note = await this.api.request<GitLabNote>(
            `/projects/${projectPath}/merge_requests/${prNumber}/notes`,
            { method: "POST", body: { body } },
        );
        return `${prNumber}::${note.id}`;
    }

    async updateComment(repoFullName: string, commentId: string, body: string): Promise<void> {
        // GitLab note updates are per-MR, but the interface only carries the
        // repo; the marker-comment flow always updates a note it just listed on
        // a known MR, so callers thread the MR through `commentId` when needed.
        // The composite form is `<mrIid>::<noteId>`; a bare id is tolerated for
        // forward-compatibility and fails with GitLab's own 404 message.
        const { mrIid, noteId } = splitCommentId(commentId);
        const projectPath = encodeProjectPath(repoFullName);
        await this.api.request(`/projects/${projectPath}/merge_requests/${mrIid}/notes/${noteId}`, {
            method: "PUT",
            body: { body },
        });
    }

    async deleteComment(repoFullName: string, commentId: string): Promise<void> {
        const { mrIid, noteId } = splitCommentId(commentId);
        const projectPath = encodeProjectPath(repoFullName);
        await this.api.request(`/projects/${projectPath}/merge_requests/${mrIid}/notes/${noteId}`, {
            method: "DELETE",
        });
    }

    async createCheckRun(params: CreateCheckRunParams): Promise<string> {
        const projectPath = encodeProjectPath(params.repoFullName);
        await this.api.request(`/projects/${projectPath}/statuses/${params.headSha}`, {
            method: "POST",
            body: {
                state: toGitLabCommitState(params.status, params.conclusion),
                context: params.name,
                description: params.title.slice(0, 255),
            },
        });
        // Commit statuses have no standalone id; updates re-post for the same
        // sha + context, so that pair IS the identifier.
        return `${params.headSha}::${params.name}`;
    }

    async updateCheckRun(params: UpdateCheckRunParams): Promise<void> {
        const separatorIndex = params.checkRunId.indexOf("::");
        if (separatorIndex < 0) {
            this.logger.warn("GitLab check-run id is not sha::context; skipping status update", {
                extra: { checkRunId: params.checkRunId },
            });
            return;
        }
        const headSha = params.checkRunId.slice(0, separatorIndex);
        const context = params.checkRunId.slice(separatorIndex + 2);
        const projectPath = encodeProjectPath(params.repoFullName);
        await this.api.request(`/projects/${projectPath}/statuses/${headSha}`, {
            method: "POST",
            body: {
                state: toGitLabCommitState(params.status ?? "completed", params.conclusion),
                context,
                description: params.title.slice(0, 255),
            },
        });
    }

    async requireStatusCheckOnAllBranches(params: RequiredCheckRulesetParams): Promise<BranchProtectionResult> {
        // GitLab's equivalent (external status checks / merge checks) is
        // tier-gated and shaped differently from repo rulesets, so the caller's
        // documented `no_permission` fallback - surfacing manual instructions -
        // is the honest behavior here.
        this.logger.info("GitLab has no repo-ruleset equivalent; deferring required check to manual setup", {
            extra: { repoFullName: params.repoFullName, contextName: params.contextName },
        });
        return { status: "no_permission" };
    }

    async removeRequiredStatusCheckRuleset(): Promise<BranchProtectionResult> {
        // Nothing was applied automatically, so removal is trivially complete.
        return { status: "applied" };
    }

    async getRepoCollaboratorPermission(repoFullName: string, username: string): Promise<RepoCollaboratorPermission> {
        const users = await this.api.request<Array<{ id: number }>>("/users", { query: { username } });
        const userId = users[0]?.id;
        if (userId == null) return "none";

        const projectPath = encodeProjectPath(repoFullName);
        const member = await this.api.request<{ access_level?: number }>(
            `/projects/${projectPath}/members/all/${userId}`,
            { tolerate404: true },
        );
        const accessLevel = member?.access_level;
        if (accessLevel == null) return "none";
        // 50 owner / 40 maintainer -> admin; 30 developer -> write; below -> read.
        if (accessLevel >= 40) return "admin";
        if (accessLevel >= 30) return "write";
        return "read";
    }

    async ensureLabelExists(repoFullName: string, name: string): Promise<void> {
        const projectPath = encodeProjectPath(repoFullName);
        const existing = await this.api.request<Array<{ name: string }>>(`/projects/${projectPath}/labels`, {
            query: { search: name },
        });
        if (existing.some((label) => label.name === name)) return;
        await this.api.request(`/projects/${projectPath}/labels`, {
            method: "POST",
            body: { name, color: DEFAULT_LABEL_COLOR },
        });
    }
}

function toRepository(project: GitLabProject): Repository {
    return {
        id: project.id,
        name: project.path,
        fullName: project.path_with_namespace,
        defaultBranch: project.default_branch ?? "main",
        private: project.visibility !== "public",
    };
}

function toPullRequestState(mr: GitLabMergeRequest): PullRequestState {
    if (mr.state === "merged") return "merged";
    if (mr.state === "closed") return "closed";
    return "open";
}

function toPullRequest(mr: GitLabMergeRequest, commitsCount: number): PullRequest {
    const state = toPullRequestState(mr);
    const merged = state === "merged";
    const result: PullRequest = {
        number: mr.iid,
        title: mr.title,
        headRef: mr.source_branch,
        headSha: mr.diff_refs?.head_sha ?? mr.sha ?? "",
        baseRef: mr.target_branch,
        baseSha: mr.diff_refs?.base_sha ?? "",
        url: mr.web_url,
        createdAt: mr.created_at,
        updatedAt: mr.updated_at,
        state,
        commitsCount,
        merged,
    };
    if (mr.description != null) result.body = mr.description;
    if (mr.author?.username != null) result.authorLogin = mr.author.username;
    if (mr.merged_at != null) result.mergedAt = mr.merged_at;
    if (merged) result.mergeMethod = mr.squash === true ? "squash" : "merge";
    const mergeCommitSha = mr.squash_commit_sha ?? mr.merge_commit_sha;
    if (mergeCommitSha != null) result.mergeCommitSha = mergeCommitSha;
    return result;
}

/** GitLab commit-status states: pending, running, success, failed, canceled. */
function toGitLabCommitState(status: CheckRunStatus, conclusion?: CheckRunConclusion): string {
    if (status === "queued") return "pending";
    if (status === "in_progress") return "running";
    if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "success";
    if (conclusion === "cancelled") return "canceled";
    return "failed";
}

function splitCommentId(commentId: string): { mrIid: string; noteId: string } {
    const separatorIndex = commentId.indexOf("::");
    if (separatorIndex < 0) return { mrIid: "0", noteId: commentId };
    return { mrIid: commentId.slice(0, separatorIndex), noteId: commentId.slice(separatorIndex + 2) };
}
