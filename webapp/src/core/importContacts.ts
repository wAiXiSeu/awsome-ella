import type { LocalStore } from './localStore'

/**
 * Batch contact import (spec §6): map header synonyms onto contact fields, validate row by row, and
 * write only the valid rows through LocalStore. Rejected rows are reported per row — the batch never
 * aborts and nothing is silently skipped.
 */

export interface ContactRow { name: string; studentNo: string; phone: string; email: string }
export interface ImportReport { valid: number; rejected: { row: number; reason: string }[] }

const SYN: Record<keyof ContactRow, string[]> = {
  name: ['姓名', '名字', '学生姓名', 'name'],
  studentNo: ['学号', '号', 'studentno', 'no'],
  phone: ['家长电话', '电话', '手机号', '联系电话', 'phone'],
  email: ['邮箱', '电子邮箱', 'email'],
}

/** Header-name resolution: first column whose text contains one of the field's synonyms. */
export function mapContactRows(rows: string[][]): ContactRow[] {
  const [header = [], ...body] = rows
  const lower = header.map(h => String(h ?? '').toLowerCase())
  const idx = (field: keyof ContactRow): number => lower.findIndex(h => SYN[field].some(s => h.includes(s)))
  const at = (r: string[], i: number): string => (i >= 0 ? r[i] ?? '' : '')
  return body.map(r => ({
    name: at(r, idx('name')),
    studentNo: at(r, idx('studentNo')),
    phone: at(r, idx('phone')),
    email: at(r, idx('email')),
  }))
}

const PHONE = /^1[3-9]\d{9}$/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function validateContacts(rows: ContactRow[]): { contacts: ContactRow[]; report: ImportReport } {
  const contacts: ContactRow[] = []
  const rejected: ImportReport['rejected'] = []
  rows.forEach((r, i) => {
    const reasons: string[] = []
    if (!r.name) reasons.push('缺少姓名')
    if (r.phone && !PHONE.test(r.phone)) reasons.push('电话位数无效')
    if (r.email && !EMAIL.test(r.email)) reasons.push('邮箱格式无效')
    if (reasons.length) rejected.push({ row: i + 2, reason: reasons.join('；') })   // 1-based, header included
    else contacts.push(r)
  })
  return { contacts, report: { valid: contacts.length, rejected } }
}

/**
 * Writes guardian phone/email onto the matching student row through LocalStore, so each edit lands
 * in the outbox and syncs like any other write. `studentNo` matches first; name is the fallback.
 */
export async function applyContacts(
  store: LocalStore,
  contacts: ContactRow[],
): Promise<{ updated: number; unmatched: string[] }> {
  const students = await store.live('students')
  let updated = 0
  const unmatched: string[] = []
  for (const c of contacts) {
    const s = students.find(x => (c.studentNo !== '' && x.studentNo === c.studentNo) || x.name === c.name)
    if (!s) { unmatched.push(c.name || c.studentNo); continue }
    await store.put('students', {
      ...s,
      guardian1Phone: c.phone || s.guardian1Phone,
      guardian1Email: c.email,
    } as Record<string, unknown> & { id: string })
    updated++
  }
  return { updated, unmatched }
}
