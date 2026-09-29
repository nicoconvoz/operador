import { describe, it, expect } from 'vitest'
import { pageOf, PAGE_SIZE } from './pagination.js'

const items = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('pageOf — Operaciones opens fifty at a time', () => {
  it('pages by fifty', () => {
    // *En Operaciones armame un paginado para abrir de a 50 tokens y que no se
    // trabe nada.* The operator, with a book heading for 250 positions.
    expect(PAGE_SIZE).toBe(50)
    const second = pageOf(items(250), 1)
    expect(second.items).toEqual(items(100).slice(50))
    expect(second).toMatchObject({ page: 1, pages: 5, from: 51, to: 100, total: 250 })
  })

  it('keeps a short last page', () => {
    const last = pageOf(items(120), 2)
    expect(last.items).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120])
    expect(last).toMatchObject({ page: 2, pages: 3, from: 101, to: 120 })
  })

  it('clamps a page past the end to the last one — a sale can shrink the book under the reader', () => {
    expect(pageOf(items(60), 7)).toMatchObject({ page: 1, pages: 2, from: 51, to: 60 })
    expect(pageOf(items(60), -3)).toMatchObject({ page: 0, from: 1, to: 50 })
  })

  it('an empty book is one empty page, never a division by zero', () => {
    expect(pageOf([], 0)).toEqual({ items: [], page: 0, pages: 1, from: 0, to: 0, total: 0 })
  })
})
