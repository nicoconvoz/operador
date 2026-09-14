/**
 * The one HTTP seam every adapter uses. Injected, so adapter tests run on
 * recorded responses and never touch the network.
 */
export type HttpGet = (url: string, init?: { readonly headers?: Record<string, string> }) => Promise<HttpResponse>

export interface HttpResponse {
  readonly status: number
  readonly json: () => Promise<unknown>
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message = `HTTP ${status} for ${url}`,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface HttpOptions {
  readonly timeoutMs?: number
  readonly userAgent?: string
}

/** Production HttpGet: global fetch with a hard timeout and gzip handled by the runtime. */
export const makeHttpGet = (options: HttpOptions = {}): HttpGet => {
  const timeoutMs = options.timeoutMs ?? 10_000
  const userAgent = options.userAgent ?? 'operador-by-open-doors/0.1'
  return async (url, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': userAgent, ...init?.headers },
      })
      return { status: response.status, json: () => response.json() as Promise<unknown> }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Test helper: an HttpGet that answers from a URL → payload table. */
export const stubHttp = (table: Record<string, { status?: number; body: unknown }>): HttpGet & { readonly calls: string[] } => {
  const calls: string[] = []
  const get: HttpGet = async (url) => {
    calls.push(url)
    const hit = Object.entries(table).find(([prefix]) => url.startsWith(prefix))
    if (!hit) return { status: 404, json: async () => ({ error: `no stub for ${url}` }) }
    const [, entry] = hit
    return { status: entry.status ?? 200, json: async () => entry.body }
  }
  return Object.assign(get, { calls })
}
