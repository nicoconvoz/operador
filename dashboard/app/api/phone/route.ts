import { buildPhoneStatus } from '../../../../src/application/phone-status.js'
import { openStore, failed } from '../../../lib/store.js'

/**
 * The cheap poll: is the engine alive, is it stopped, is there anything new.
 *
 * No fills, no P&L, no scan — this runs every minute forever on a free
 * database, and the moment it stops being cheap it stops being something you
 * can leave running.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const status = await buildPhoneStatus(openStore(), { now: () => Date.now() })
    return Response.json(status, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failed(error)
  }
}
