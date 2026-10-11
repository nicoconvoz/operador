/**
 * Writes one file onto a branch of its own, replacing it whole every time.
 *
 * The engine keeps its state this way (`state-sync.ts`), so neither it nor the
 * screen needs a database. Four calls to the git data
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

  /**
   * One file as the branch holds it NOW, through the API — never the raw CDN,
   * which may serve a copy minutes old. Null when the branch or the file does
   * not exist yet.
   */
  async read(path: string): Promise<string | null> {
    const ref = await this.request('GET', `/git/ref/heads/${this.options.branch}`)
    if (ref.status === 404) return null
    if (!ref.ok) throw new Error(`GitHub ${ref.status} reading ${this.options.branch}: ${(await ref.text()).slice(0, 200)}`)
    const commitSha = ((await ref.json()) as { object: { sha: string } }).object.sha
    const commit = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${commitSha}`)
    const tree = await this.call<{ tree: { path: string; sha: string; type: string }[] }>('GET', `/git/trees/${commit.tree.sha}`)
    const entry = tree.tree.find((e) => e.path === path && e.type === 'blob')
    if (!entry) return null
    const blob = await this.call<{ content: string; encoding: string }>('GET', `/git/blobs/${entry.sha}`)
    return Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
  }

  private request(method: string, path: string, body?: unknown): Promise<FetchResponse> {
    return this.fetch(`${this.base}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
    })
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body)
    if (!response.ok) throw new Error(`GitHub ${response.status} on ${path}: ${(await response.text()).slice(0, 200)}`)
    return (await response.json()) as T
  }
}
