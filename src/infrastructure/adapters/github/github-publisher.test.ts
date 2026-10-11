import { describe, expect, it } from 'vitest'
import { GitHubPublisher } from './github-publisher.js'

interface Call { readonly method: string; readonly url: string; readonly body: Record<string, unknown> | null; readonly auth: string | null }

/** A fake GitHub: records every call and answers like the git data API. */
const fakeGitHub = (refExists: boolean) => {
  const calls: Call[] = []
  const fetch = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.authorization ?? null })
    const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
    if (url.endsWith('/git/blobs')) return json(201, { sha: 'blob1' })
    if (url.endsWith('/git/trees')) return json(201, { sha: 'tree1' })
    if (url.endsWith('/git/commits')) return json(201, { sha: 'commit1' })
    if (method === 'PATCH') return refExists ? json(200, {}) : json(422, { message: 'Reference does not exist' })
    if (method === 'POST' && url.endsWith('/git/refs')) return json(201, {})
    return json(404, {})
  }
  return { calls, fetch }
}

describe('GitHubPublisher — one file on its own branch, replaced every time', () => {
  // The engine writes the view the dashboard reads onto a branch of its own,
  // as ONE parentless commit force-moved each time: the branch never grows a
  // history, and the old snapshots become unreachable objects GitHub collects.
  it('writes the file as a parentless commit and force-moves the branch to it', async () => {
    const gh = fakeGitHub(true)
    await new GitHubPublisher({ repo: 'me/repo', branch: 'view', token: 'tok', fetch: gh.fetch }).publish({ 'view.json': '{"a":1}', 'vercel.json': '{}' }, 'view 1')
    expect(gh.calls.map((c) => `${c.method} ${c.url.replace('https://api.github.com/repos/me/repo', '')}`)).toEqual([
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/view',
    ])
    expect(gh.calls[0]!.body).toEqual({ content: Buffer.from('{"a":1}').toString('base64'), encoding: 'base64' })
    expect(gh.calls[2]!.body).toEqual({ tree: [{ path: 'view.json', mode: '100644', type: 'blob', sha: 'blob1' }, { path: 'vercel.json', mode: '100644', type: 'blob', sha: 'blob1' }] })
    expect(gh.calls[3]!.body).toEqual({ message: 'view 1', tree: 'tree1', parents: [] })
    expect(gh.calls[4]!.body).toEqual({ sha: 'commit1', force: true })
    expect(gh.calls.every((c) => c.auth === 'Bearer tok')).toBe(true)
  })

  it('creates the branch the first time', async () => {
    const gh = fakeGitHub(false)
    await new GitHubPublisher({ repo: 'me/repo', branch: 'view', token: 'tok', fetch: gh.fetch }).publish({ 'view.json': '{}' }, 'view')
    expect(gh.calls.at(-1)).toMatchObject({ method: 'POST', body: { ref: 'refs/heads/view', sha: 'commit1' } })
  })

  it('throws when GitHub refuses, so the caller can say so', async () => {
    const fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'forbidden' })
    await expect(new GitHubPublisher({ repo: 'me/repo', branch: 'view', token: 'tok', fetch }).publish({ 'view.json': '{}' }, 'view')).rejects.toThrow(/403/)
  })
})
