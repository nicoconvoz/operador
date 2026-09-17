import { buildView } from '../../../lib/view.js'
import { openStore, failed } from '../../../lib/store.js'

/**
 * Everything the screen shows, in one request.
 *
 * The page used to be reloaded to refresh it, which wiped the canvas, reset
 * every orbit and dropped whatever the viewer had selected — a flinch once a
 * minute that told them nothing. Now the page fetches this and swaps the data
 * underneath itself.
 *
 * One request rather than three: three would arrive at three different moments
 * and the screen would show a position that exists in one panel and not the
 * other. A single read is a single instant.
 *
 * The building itself lives in `lib/view.ts`, shared with the server-rendered
 * first frame — see the note there for what happened when it did not.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    return Response.json(await buildView(openStore()), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failed(error)
  }
}
