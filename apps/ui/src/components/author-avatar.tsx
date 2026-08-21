import { useGitProvider } from "components/provider-logo";
import { useState } from "react";

/**
 * Deterministic hue per login so a person keeps their color across renders and
 * surfaces without any avatar service involved.
 */
function loginHue(login: string): number {
  let hash = 0;
  for (let index = 0; index < login.length; index++) {
    hash = (hash * 31 + login.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * A commit or PR author's avatar. GitHub workspaces load the real avatar from
 * github.com by login; every other provider renders an initial on a stable
 * per-login color instead - GitLab has no public avatar-by-username URL, and
 * fetching github.com/<login>.png for a GitLab user either 404s (broken image)
 * or, worse, shows an unrelated GitHub user who happens to share the name.
 * A GitHub avatar that fails to load falls back to the same initial.
 */
export function AuthorAvatar({ login, className, title }: { login: string; className?: string; title?: string }) {
  const provider = useGitProvider();
  const [failed, setFailed] = useState(false);

  if (provider === "github" && !failed) {
    return (
      <img
        src={`https://github.com/${encodeURIComponent(login)}.png?size=48`}
        alt={login}
        title={title}
        onError={() => setFailed(true)}
        className={`border border-border-dim bg-surface-raised object-cover ${className ?? ""}`}
      />
    );
  }

  return (
    <span
      title={title}
      aria-label={login}
      role="img"
      style={{ backgroundColor: `hsl(${loginHue(login)} 45% 32%)` }}
      className={`inline-flex select-none items-center justify-center border border-border-dim text-[9px] font-semibold uppercase leading-none text-white ${className ?? ""}`}
    >
      {login.slice(0, 1)}
    </span>
  );
}
