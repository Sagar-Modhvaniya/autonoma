import { useQuery } from "@tanstack/react-query";
import { trpc } from "lib/trpc";
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
 * A commit or PR author's avatar, resolved through the workspace's connected
 * provider: github.com's public avatar endpoint for GitHub, the instance's
 * users API for GitLab (whose avatar_url - an upload or a gravatar - is
 * publicly fetchable). Guessing github.com/<login>.png for every provider
 * either 404s or, worse, shows an unrelated GitHub user who shares the name.
 * While resolving, and whenever the image fails to load, an initial on a
 * stable per-login color renders instead.
 */
export function AuthorAvatar({ login, className, title }: { login: string; className?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  const { data } = useQuery({
    ...trpc.github.getAuthorAvatars.queryOptions({ logins: [login] }),
    staleTime: 60 * 60 * 1000,
  });
  const avatarUrl = data?.[login];

  if (avatarUrl != null && !failed) {
    return (
      <img
        src={avatarUrl}
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
