import { AuthorAvatar } from "components/author-avatar";
import { usePullRequestCommits } from "lib/query/github.queries";

/**
 * Overlapping stack of author avatars for a PR's authors.
 * Default: avatars overlap. On hover the stack expands with a small gap.
 * The PR author is placed first; additional unique commit authors follow.
 */
export function PRAuthorStack({
  applicationId,
  prNumber,
  primaryAuthor,
}: {
  applicationId: string;
  prNumber: number;
  primaryAuthor: string | undefined;
}) {
  const { data: commits } = usePullRequestCommits(applicationId, prNumber);

  const authors = collectAuthors(primaryAuthor, commits);
  if (authors.length === 0) return null;

  return (
    <div className="group/authors flex items-center">
      {authors.map((login, index) => (
        <AuthorAvatar
          key={login}
          login={login}
          title={login}
          className={`size-5 shrink-0 ring-1 ring-surface-void transition-[margin] duration-150 ${
            index === 0 ? "" : "-ml-2 group-hover/authors:ml-1"
          }`}
        />
      ))}
    </div>
  );
}

function collectAuthors(
  primaryAuthor: string | undefined,
  commits: Array<{ authorLogin?: string }> | undefined,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  function push(login: string | undefined) {
    if (login == null || login.length === 0) return;
    if (seen.has(login)) return;
    seen.add(login);
    ordered.push(login);
  }

  push(primaryAuthor);
  if (commits != null) {
    for (const commit of commits) push(commit.authorLogin);
  }
  return ordered;
}
