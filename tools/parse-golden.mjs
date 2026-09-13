#!/usr/bin/env node
/**
 * Converts a raw Pine Logs export into golden fixtures the test suite reads.
 *
 *   node tools/parse-golden.mjs tools/golden/BLESS-1H.raw.csv bless-1h
 *
 * The raw file is TradingView's own log download: `Date,Message` rows where
 * Message is our SEED= or CSV= payload. "na" becomes null, matching this
 * codebase's representation of Pine's na.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , rawPath, name] = process.argv
if (!rawPath || !name) {
  console.error('usage: parse-golden.mjs <raw-csv> <fixture-name>')
  process.exit(1)
}

const num = (token) => (token === 'na' || token === '' ? null : Number(token))

/** Strips the `Date,"` prefix and trailing quote from a log row. */
const payload = (line) => {
  const comma = line.indexOf(',')
  if (comma === -1) return null
  return line.slice(comma + 1).replace(/^"|"$/g, '').replaceAll('""', '"')
}

const lines = readFileSync(rawPath, 'utf8').split(/\r?\n/).filter(Boolean)

const seedRows = []
const barRows = []
let seedHeader = null
let barHeader = null

for (const line of lines) {
  const message = payload(line)
  if (!message) continue

  if (message.startsWith('SEED=')) {
    const fields = message.slice(5).split(',')
    if (fields[0] === 'bar_index') seedHeader = fields
    else seedRows.push(fields.map(num))
  } else if (message.startsWith('CSV=')) {
    const fields = message.slice(4).split(',')
    if (fields[0] === 'time') barHeader = fields
    else barRows.push(fields.map(num))
  }
}

/**
 * The v1 exporter copied DCA.pine's destructuring, `[bb_up, bb_mid, bb_lo]`.
 * Pine's ta.bb actually returns [basis, upper, lower], so all three names were
 * shifted. The NUMBERS were always correct — only the labels were wrong, and
 * the golden data proves the true order: element 0 equals ta.sma(close, length)
 * to 0.0000000000%, and the bands are exactly symmetric around it.
 */
const V1_BB_REMAP = { bb_up: 'bb_basis', bb_mid: 'bb_upper', bb_lo: 'bb_lower' }

const toObjects = (header, rows) =>
  rows.map((row) =>
    Object.fromEntries(header.map((key, i) => [V1_BB_REMAP[key] ?? key, row[i] ?? null])),
  )

/**
 * A still-forming realtime bar is logged on every tick, so the final bar can
 * appear more than once with slightly different values. Keep the last sample
 * of each timestamp — duplicates silently corrupt every windowed indicator.
 */
const dedupeByTime = (rows) => {
  const byTime = new Map()
  for (const row of rows) byTime.set(row.time, row)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

const fixture = {
  source: rawPath,
  generatedFrom: 'TradingView Pine Logs via tools/golden-exporter.pine',
  seed: seedHeader ? toObjects(seedHeader, seedRows) : [],
  bars: barHeader ? dedupeByTime(toObjects(barHeader, barRows)) : [],
}

const out = resolve(`src/domain/indicators/__golden__/${name}.json`)
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n')
console.log(`${out}: ${fixture.seed.length} seed rows, ${fixture.bars.length} bars`)
