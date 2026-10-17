import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Table } from 'dexie'
import { openDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { parseCsv, xlsxToSheets, inflateRaw } from '../../src/core/legacyParsers'
import { validateContacts, mapContactRows, applyContacts } from '../../src/core/importContacts'
import type { Row } from '../../src/core/types'
import { buildContactsXlsx } from '../fixtures/buildContactsXlsx'

const readFixture = (): string[][] => parseCsv(readFileSync('test/fixtures/contacts.csv', 'utf8'))

async function mkStore(dbName: string): Promise<LocalStore> {
  const db = await openDb(dbName)
  await db.registerTable('students')
  const meta = new MetaStore(db)
  return new LocalStore({
    db, meta, deviceId: 'dA', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string>,
  })
}

describe('legacy parsers (index.html:106-133 port)', () => {
  it('parses the csv fixture into rows with headers', () => {
    const rows = readFixture()
    expect(rows[0]).toEqual(['姓名', '学号', '家长电话', '邮箱'])
    expect(rows.length).toBe(4)
  })

  it('keeps the original quote/tab semantics: separators inside quotes, doubled quotes, tabs', () => {
    const rows = parseCsv('a,"b,c",d\te\n"say ""hi""",2,3')
    expect(rows[0]).toEqual(['a', 'b,c', 'd', 'e'])
    expect(rows[1]).toEqual(['say "hi"', '2', '3'])
  })

  it('reads a real xlsx package: workbook rels, shared strings, cell refs', async () => {
    const sheets = await xlsxToSheets(buildContactsXlsx())
    expect(sheets.length).toBe(1)
    expect(sheets[0].name).toBe('通讯录')
    expect(sheets[0].rows[0]).toEqual(['姓名', '学号', '家长电话', '邮箱'])
    expect(sheets[0].rows[1][0]).toBe('张三')
    expect(sheets[0].rows.length).toBe(4)
    expect(sheets[0].rows[3][2]).toBe('')            // an empty cell stays ''
  })

  it('rejects a buffer that is not a zip', async () => {
    const junk = new TextEncoder().encode('not a spreadsheet').buffer
    await expect(xlsxToSheets(junk)).rejects.toThrow('不是有效的xlsx文件')
  })

  it('the ported inflate fallback decodes what the platform decoder decodes', async () => {
    // DecompressionStream exists in node 24, so xlsxToSheets uses the fast path; exercise the
    // hand-ported inflater directly against the same deflate-raw bytes.
    const { deflateRawSync } = await import('node:zlib')
    const text = '班级通讯录 '.repeat(200) + 'ABC'
    const raw = new Uint8Array(deflateRawSync(Buffer.from(text, 'utf8')))
    const back = inflateRaw(raw)
    expect(back).not.toBeNull()
    expect(new TextDecoder().decode(back!)).toBe(text)
    // stored (uncompressed) blocks too - the zip reader hits them for method 0 entries
    const stored = new Uint8Array(deflateRawSync(Buffer.from('hello'), { level: 0 }))
    expect(new TextDecoder().decode(inflateRaw(stored)!)).toBe('hello')
  })
})

describe('contact import (spec §6)', () => {
  it('maps header synonyms onto the canonical contact fields', () => {
    const mapped = mapContactRows(readFixture())
    expect(mapped[0]).toMatchObject({ name: '张三', studentNo: '01', phone: '13800000001', email: 'zs@example.com' })
    expect(mapped.length).toBe(3)
  })

  it('row-level validation: bad phone/email rejected with a reason, good rows kept (no abort, no silent skip)', () => {
    const { contacts, report } = validateContacts(mapContactRows(readFixture()))
    expect(contacts.length).toBe(1)
    expect(report.valid).toBe(1)
    expect(report.rejected.length).toBe(2)
    expect(report.rejected[0].reason).toContain('电话')
    expect(report.rejected[0].row).toBe(3)            // 1-based, header row included
    expect(report.rejected[1].reason).toContain('邮箱')
  })

  it('applies valid contacts onto matched students through LocalStore, so they queue for sync', async () => {
    const store = await mkStore('imp-' + Math.random())
    await store.put('students', { id: 's1', name: '张三', studentNo: '01', guardian1Phone: 'old' })
    await store.put('students', { id: 's2', name: '赵六', studentNo: '09' })
    const before = await store.pendingCount()

    const { contacts } = validateContacts(mapContactRows(readFixture()))
    const applied = await applyContacts(store, contacts)
    expect(applied.updated).toBe(1)
    expect(applied.unmatched).toEqual([])
    const s1 = await store.get('students', 's1')
    expect(s1!.guardian1Phone).toBe('13800000001')
    expect(s1!.guardian1Email).toBe('zs@example.com')
    expect(await store.pendingCount()).toBe(before + 1)   // the import is an ordinary local write
  })

  it('reports rows whose student is not in the class instead of inventing one', async () => {
    const store = await mkStore('imp2-' + Math.random())
    const { contacts } = validateContacts(mapContactRows(readFixture()))
    const applied = await applyContacts(store, contacts)
    expect(applied.updated).toBe(0)
    expect(applied.unmatched).toEqual(['张三'])
  })
})
