const repo = "temcwilliams/codex-convos";
let cache = null,
  checked = 0,
  pending;
export async function loadProject(fetcher = fetch) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Codex-Convos-Tracker",
  };
  const endpoints = [
    "commits?per_page=5",
    "pulls?state=open&per_page=5",
    "actions/runs?per_page=5",
  ];
  const results = await Promise.all(
    endpoints.map(async (path) => {
      try {
        const r = await fetcher(
          `https://api.github.com/repos/${repo}/${path}`,
          { headers, signal: AbortSignal.timeout(10000) },
        );
        if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
        return { data: await r.json(), error: null };
      } catch (e) {
        return { data: null, error: e.message };
      }
    }),
  );
  return {
    name: "CODEX CONVOS",
    repo,
    url: `https://github.com/${repo}`,
    checkedAt: Date.now(),
    refreshSeconds: 300,
    commits: (results[0].data || []).map((c) => ({
      sha: c.sha,
      title: c.commit?.message?.split("\n")[0] || "Commit",
      date: c.commit?.committer?.date,
    })),
    pulls: (results[1].data || []).map((p) => ({
      number: p.number,
      title: p.title,
    })),
    builds: (results[2].data?.workflow_runs || []).map((r) => ({
      id: r.id,
      title: r.name,
      status: r.conclusion || r.status,
    })),
    errors: results
      .map((r, i) =>
        r.error
          ? `${["Commits", "Pull requests", "Builds"][i]}: ${r.error}`
          : null,
      )
      .filter(Boolean),
  };
}
export async function getProject() {
  if (cache && Date.now() - checked < 300000) return cache;
  if (!pending)
    pending = loadProject()
      .then((data) => {
        cache = data;
        checked = Date.now();
        return data;
      })
      .finally(() => {
        pending = null;
      });
  return pending;
}
