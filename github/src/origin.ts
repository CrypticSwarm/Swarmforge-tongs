// Turning the workspace's `origin` URL into the one repository this tong may touch.
//
// There is no verb parameter for owner/repo and no configuration knob: the answer
// is derived here, once, at startup, from what the human checked out. `owner` and
// `repo` are interpolated into the push URL, so anything that is not a plain name
// is rejected rather than escaped.

export class OriginError extends Error {}

export type Origin = {
  owner: string;
  repo: string;
};

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

// GitHub logins: alphanumeric with single internal hyphens, 39 characters max.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// `.` and `..` match this class too, and are excluded separately.
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** `scheme://[user@]host[:port]/path`, and the scp-like `[user@]host:path`. */
function splitUrl(url: string): { host: string; path: string } {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(url);

  if (schemeMatch) {
    const [, scheme, rest] = schemeMatch;
    // git understands many more, `ext::` and `file://` among them. Only the three
    // that can name github.com over a network are accepted.
    if (!["ssh", "https", "git"].includes(scheme.toLowerCase())) {
      throw new OriginError(`origin uses the '${scheme}' transport; only ssh, https, and git are understood`);
    }
    const slash = rest.indexOf("/");
    if (slash === -1) throw new OriginError(`origin '${url}' has no repository path`);
    return { host: rest.slice(0, slash), path: rest.slice(slash + 1) };
  }

  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon === -1 || (slash !== -1 && slash < colon)) {
    throw new OriginError(`origin '${url}' is not a URL this tong understands`);
  }
  return { host: url.slice(0, colon), path: url.slice(colon + 1) };
}

function bareHost(host: string): string {
  const at = host.lastIndexOf("@");
  const withoutUser = at === -1 ? host : host.slice(at + 1);
  const colon = withoutUser.indexOf(":");
  return (colon === -1 ? withoutUser : withoutUser.slice(0, colon)).toLowerCase();
}

export function parseOrigin(rawUrl: string): Origin {
  const url = rawUrl.trim();
  if (!url) throw new OriginError("the workspace has no 'origin' remote configured");

  if (/[\u0000-\u001f\u007f]/.test(url)) {
    throw new OriginError("origin contains control characters");
  }

  const { host, path } = splitUrl(url);
  const hostname = bareHost(host);
  if (!GITHUB_HOSTS.has(hostname)) {
    throw new OriginError(
      `origin points at '${hostname}', not github.com. This tong holds a github.com token and will not ` +
        `push anywhere else.`,
    );
  }

  const segments = path
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment.length > 0);

  if (segments.length !== 2) {
    throw new OriginError(`origin path '${path}' is not <owner>/<repo>`);
  }

  const [owner, repo] = segments;
  if (!OWNER.test(owner)) throw new OriginError(`origin owner '${owner}' is not a valid GitHub account name`);
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    throw new OriginError(`origin repository '${repo}' is not a valid GitHub repository name`);
  }

  return { owner, repo };
}

/**
 * Built from the pinned owner/repo rather than from the remote named `origin`,
 * which is what makes the pin enforceable rather than merely remembered: the agent
 * owns the workspace and can `git remote set-url origin` at any moment.
 *
 * `x-access-token` is a username. The token is not in this string.
 */
export function pushUrl(origin: Origin): string {
  return `https://x-access-token@github.com/${origin.owner}/${origin.repo}.git`;
}
