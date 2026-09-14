#!/usr/bin/env node
/**
 * Converts the Pine Logs download from tools/DCA-logged.pine into the golden
 * trade fixture the parity test reads.
 *
 *   node tools/parse-trades.mjs tools/golden/BLESS-1H.trades.raw.csv bless-1h
 *
 * Emits src/domain/indicators/__golden__/<name>.trades.json with:
 *   inputs    — every strategy input as TradingView ran it
 *   syminfo   — mintick, ticker, timeframe, initial capital
 *   states    — STATE= lines: the machine's own view when `level` changed
 *   entries   — ENTRY= lines: real fills that opened or added
 *   closed    — CLOSED= lines: the Strategy Tester trade list, one per entry
 *   open      — OPEN= lines: still open at the end of history
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , rawPath, name] = process.argv
if (!rawPath || !name) {
  console.error('usage: parse-trades.mjs <raw-csv> <fixture-name>')
  process.exit(1)
}

const payload = (line) => {
  const comma = line.indexOf(',')
  if (comma === -1) return null
  return line.slice(comma + 1).replace(/^"|"$/g, '').replaceAll('""', '"')
}

const num = (s) => (s === 'na' || s === '' || s === undefined ? null : Number(s))
const kv = (body, sep) =>
  Object.fromEntries(
    body.split(sep).map((pair) => {
      const eq = pair.indexOf('=')
      return [pair.slice(0, eq), pair.slice(eq + 1)]
    }),
  )

const fixture = { source: rawPath, inputs: {}, syminfo: {}, states: [], entries: [], closed: [], open: [] }

for (const line of readFileSync(rawPath, 'utf8').split(/\r?\n/)) {
  const message = payload(line)
  if (!message) continue
  const eq = message.indexOf('=')
  const tag = message.slice(0, eq)
  const body = message.slice(eq + 1)

  switch (tag) {
    case 'INPUTS':
      fixture.inputs = Object.fromEntries(
        Object.entries(kv(body, ';')).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v)]),
      )
      break
    case 'SYMINFO':
      fixture.syminfo = Object.fromEntries(
        Object.entries(kv(body, ';')).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]),
      )
      break
    case 'STATE': {
      const [time, ...rest] = body.split(',')
      const f = kv(rest.join(','), ',')
      fixture.states.push({ time: Number(time), level: Number(f.level), ep1: num(f.ep1), totalInv: num(f.total_inv), close: num(f.close) })
      break
    }
    case 'ENTRY': {
      const [time, ...rest] = body.split(',')
      const f = kv(rest.join(','), ',')
      fixture.entries.push({ time: Number(time), id: f.id, price: num(f.price), size: num(f.size), comment: f.comment })
      break
    }
    case 'CLOSED': {
      const [exitTime, ...rest] = body.split(',')
      const f = kv(rest.join(','), ',')
      fixture.closed.push({
        id: f.id,
        entryTime: Number(f.entry_time),
        entryPrice: num(f.entry_price),
        exitTime: Number(exitTime),
        exitPrice: num(f.exit_price),
        size: num(f.size),
        profit: num(f.profit),
        commission: num(f.commission),
        exitComment: f.exit_comment,
      })
      break
    }
    case 'OPEN': {
      const [time, ...rest] = body.split(',')
      const f = kv(rest.join(','), ',')
      fixture.open.push({ entryTime: Number(time), id: f.id, price: num(f.price), size: num(f.size) })
      break
    }
    default:
      break
  }
}

// Realtime bars log on every tick; keep one record per (time, id).
const dedupe = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()]
fixture.entries = dedupe(fixture.entries, (r) => `${r.time}|${r.id}`)
fixture.closed = dedupe(fixture.closed, (r) => `${r.entryTime}|${r.id}|${r.exitTime}`)
fixture.states = dedupe(fixture.states, (r) => `${r.time}|${r.level}`)

const out = resolve(`src/domain/indicators/__golden__/${name}.trades.json`)
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n')
console.log(`${out}: ${fixture.entries.length} entries, ${fixture.closed.length} closed, ${fixture.open.length} open, ${fixture.states.length} state changes`)
console.log('inputs:', fixture.inputs)
console.log('syminfo:', fixture.syminfo)
