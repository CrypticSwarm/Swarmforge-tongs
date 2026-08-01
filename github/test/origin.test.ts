import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OriginError, parseOrigin, pushUrl } from "../src/origin.js";

describe("parseOrigin", () => {
  const accepted: Array<[string, string, string]> = [
    ["git@github.com:acme/widgets.git", "acme", "widgets"],
    ["git@github.com:acme/widgets", "acme", "widgets"],
    ["ssh://git@github.com/acme/widgets.git", "acme", "widgets"],
    ["ssh://git@github.com:22/acme/widgets.git", "acme", "widgets"],
    ["https://github.com/acme/widgets.git", "acme", "widgets"],
    ["https://user@github.com/acme/widgets", "acme", "widgets"],
    ["git://github.com/acme/widgets.git", "acme", "widgets"],
    ["https://GitHub.com/acme/widgets", "acme", "widgets"],
    ["  git@github.com:acme/widgets.git\n", "acme", "widgets"],
    // The form GitHub hands out for SAML/SSO org access.
    ["org-1234567@github.com:acme/widgets.git", "acme", "widgets"],
    // Dots, underscores and hyphens are all legal in a repository name.
    ["git@github.com:a-corp/my_repo.v2.git", "a-corp", "my_repo.v2"],
  ];

  for (const [url, owner, repo] of accepted) {
    it(`accepts ${JSON.stringify(url)}`, () => {
      assert.deepEqual(parseOrigin(url), { owner, repo });
    });
  }

  const rejected: Array<[string, string]> = [
    ["git@gitlab.com:acme/widgets.git", "another host"],
    ["https://github.example.com/acme/widgets.git", "a lookalike host"],
    ["https://github.com.evil.test/acme/widgets.git", "a suffixed host"],
    ["git@github.com-personal:acme/widgets.git", "an ssh config alias"],
    ["ext::sh -c 'curl evil'", "an ext:: transport"],
    ["file:///tmp/repo", "a file:// transport"],
    ["/srv/git/repo.git", "a bare local path"],
    ["git@github.com:acme/widgets/extra.git", "a three-segment path"],
    ["git@github.com:acme.git", "a one-segment path"],
    ["git@github.com:acme/../../etc/passwd", "path traversal"],
    ["git@github.com:acme/.git", "a dot repository"],
    ["", "an empty remote"],
  ];

  for (const [url, why] of rejected) {
    it(`rejects ${why}`, () => {
      assert.throws(() => parseOrigin(url), OriginError);
    });
  }

  it("rejects a remote carrying a newline", () => {
    assert.throws(() => parseOrigin("git@github.com:acme/widgets.git\nfetch = evil"), OriginError);
  });
});

describe("pushUrl", () => {
  it("is built from the pin, over https, with no token in it", () => {
    const url = pushUrl({ owner: "acme", repo: "widgets" });
    assert.equal(url, "https://x-access-token@github.com/acme/widgets.git");
  });

  it("stays on github.com whatever the workspace's own remote says", () => {
    // The point of building the URL rather than pushing to the remote named
    // `origin`: a later `git remote set-url` cannot redirect this.
    assert.equal(
      pushUrl(parseOrigin("git@github.com:acme/widgets.git")),
      pushUrl(parseOrigin("https://github.com/acme/widgets")),
    );
  });
});
