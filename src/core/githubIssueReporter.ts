/**
 * Files a GitHub issue when the Reviewer finds a capability failing
 * repeatedly — the bridge between JARVIS detecting a problem and a
 * scheduled Claude Code session picking it up to diagnose and fix (see
 * docs/architecture.md "Autonomous fix loop"). JARVIS itself never writes
 * code or deploys anything; it only ever reports what it found.
 *
 * This exists because the deployed JARVIS orchestrator has normal
 * outbound internet access (to reach GitHub), while a Claude Code session
 * has no path back into the NUC — polling JARVIS's own API from a
 * schedule isn't reachable, but GitHub is reachable from both directions.
 *
 * Deliberately narrow: this can only ever create an issue with a fixed
 * title/label shape. It has no path to modify code, open a PR, or touch
 * anything beyond filing a report — the actual fix always goes through a
 * human-reviewed PR, opened by a Claude Code session, never by JARVIS.
 */
export interface GithubIssueReporter {
  reportFailure(capability: string, summary: string, count: number): Promise<void>;
}

const GITHUB_API = "https://api.github.com";
const ISSUE_LABEL = "jarvis-auto-detected";

function issueTitle(capability: string): string {
  return `[jarvis-capability-failure] ${capability}`;
}

/** No-op when GITHUB_CRED/repo aren't configured — this integration is opt-in, chat still works without it. */
export function createGithubIssueReporter(token: string | null, repo: string | null): GithubIssueReporter {
  if (!token || !repo) {
    return { reportFailure: async () => {} };
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "jarvis-v2-reviewer",
  };

  return {
    async reportFailure(capability, summary, count) {
      const title = issueTitle(capability);

      // Dedup: skip if an open issue for this capability already exists —
      // the scheduled fix-loop session will pick it up on its own cadence,
      // no need to re-report every reviewer cycle in the meantime.
      const query = `repo:${repo} is:issue is:open in:title "${title}"`;
      const searchRes = await fetch(`${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}`, { headers });
      if (searchRes.ok) {
        const body = (await searchRes.json()) as { total_count: number };
        if (body.total_count > 0) return;
      }

      await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title,
          body:
            `JARVIS's Reviewer detected \`${capability}\` failing ${count}x in the last 24h.\n\n` +
            `**Latest error:**\n\`\`\`\n${summary}\n\`\`\`\n\n` +
            "Filed automatically. Diagnose the root cause, write a fix, verify it with tests, and open a PR " +
            "against the dev branch for review — never merge or deploy without a human approving it.",
          labels: [ISSUE_LABEL],
        }),
      });
    },
  };
}
