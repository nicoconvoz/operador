/**
 * Writes one file onto a branch of its own, replacing it whole every time.
 *
 * The engine publishes the view the dashboard reads (`view-snapshot.ts`) this
 * way, so Vercel reads GitHub instead of Postgres. Four calls to the git data
 * API: the blob, a tree holding only that file, a commit with NO parent, and
 * the branch force-moved onto it. The branch therefore never grows a history —
 * a snapshot every two minutes for a month would otherwise be twenty thousand
 * commits — and the replaced snapshots become unreachable objects GitHub
 * collects on its own.
 *
 * No SDK: four POSTs and a PATCH are shorter than the import.
 */

interface FetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

export type GitHubFetch = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<FetchResponse>

export interface GitHubPublisherOptions {
  /** `owner/name`. */
  readonly repo: string
  readonly branch: string
  readonly token: string
  readonly fetch?: GitHubFetch
}

export class GitHubPublisher {
  private readonly base: string
  private readonly fetch: GitHubFetch

  constructor(private readonly options: GitHubPublisherOptions) {
    this.base = `https://api.github.com/repos/${options.repo}`
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as GitHubFetch)
  }

  /** Every file in `files` (path → content) as the branch's whole tree. */
  async publish(files: Readonly<Record<string, string>>, message: string): Promise<void> {
    const entries: { path: string; mode: string; type: string; sha: string }[] = []
    for (const [path, content] of Object.entries(files)) {
      const blob = await this.call<{ sha: string }>('POST', '/git/blobs', { content: Buffer.from(content).toString('base64'), encoding: 'base64' })
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    }
    const tree = await this.call<{ sha: string }>('POST', '/git/trees', { tree: entries })
    const commit = await this.call<{ sha: string }>('POST', '/git/commits', { message, tree: tree.sha, parents: [] })
    const moved = await this.request('PATCH', `/git/refs/heads/${this.options.branch}`, { sha: commit.sha, force: true })
    if (moved.ok) return
    // The first time there is no branch to move.
    if (moved.status === 422 || moved.status === 404) {
      await this.call('POST', '/git/refs', { ref: `refs/heads/${this.options.branch}`, sha: commit.sha })
      return
    }
    throw new Error(`GitHub ${moved.status} moving ${this.options.branch}: ${(await moved.text()).slice(0, 200)}`)
  }

  private request(method: string, path: string, body: unknown): Promise<FetchResponse> {
    return this.fetch(`${this.base}${path}`, {
      method,
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
    })
  }

  private async call<T>(method: string, path: string, body: unknown): Promise<T> {
    const response = await this.request(method, path, body)
    if (!response.ok) throw new Error(`GitHub ${response.status} on ${path}: ${(await response.text()).slice(0, 200)}`)
    return (await response.json()) as T
  }
}
