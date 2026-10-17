import { describe, it, expect } from 'vitest'
import { TABLE_DEFS, coveredLegacyKeys, legacyKeyIndex, registerAllTables } from '../../src/core/schema'
import { openDb } from '../../src/core/db'

describe('schema registry', () => {
  it('covers every legacy key from index.html load() (line 90) — exams included', () => {
    const legacyTopKeys = ['students','todos','schedule','seating','duty','violations','communications','grades','exams','homework','points','drafts','activities','behaviors','committee','settings']
    const kSet = coveredLegacyKeys()
    for (const k of legacyTopKeys) expect(kSet.has(k), 'missing legacyKey: ' + k).toBe(true)
    const idx = legacyKeyIndex()
    expect(TABLE_DEFS.find(d => d.name === 'exams')!.legacyKey).toBe('exams')
    expect(TABLE_DEFS.find(d => d.name === 'notices')!.legacySubKey).toBe('notices')
    expect(TABLE_DEFS.find(d => d.name === 'students')!.dropColumns).toContain('idCard')
    expect(idx['drafts.notices']!.name).toBe('notices')
  })
  it('registers all tables into the dexie db idempotently', async () => {
    const db = await openDb('sch-' + Math.random())
    await registerAllTables(db)
    await registerAllTables(db)
    expect(db.business.size).toBe(TABLE_DEFS.length)
  })
})
