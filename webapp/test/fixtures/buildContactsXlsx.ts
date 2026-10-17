import { deflateRawSync } from 'node:zlib'

/**
 * Builds a real (minimal) .xlsx as an ArrayBuffer so `xlsxToSheets` is tested against an actual
 * zip + deflate-raw stream instead of a committed binary blob. Test-only: uses node:zlib, which the
 * app itself never touches (the app path is DecompressionStream + the ported inflate).
 */

const CRC_TABLE: number[] = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE.push(c >>> 0)
}
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export const CONTACT_HEADER = ['姓名', '学号', '家长电话', '邮箱']
export const CONTACT_BODY: string[][] = [
  ['张三', '01', '13800000001', 'zs@example.com'],
  ['李四', '02', '1390', 'li@example.com'],
  ['王五', '03', '', 'not-an-email'],
]

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function sheetXml(strings: string[]): string {
  const sid = (s: string): number => {
    const i = strings.indexOf(s)
    if (i >= 0) return i
    strings.push(s)
    return strings.length - 1
  }
  const rows = [CONTACT_HEADER, ...CONTACT_BODY].map((cells, ri) => {
    const refs = cells.map((v, ci) => `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="s"><v>${sid(v)}</v></c>`)
    return `<row r="${ri + 1}">${refs.join('')}</row>`
  }).join('')
  return rows
}

function parts(strings: string[], sheetData: string): Record<string, string> {
  const sst = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map(s => `<si><t>${esc(s)}</t></si>`).join('') + '</sst>'
  const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  return {
    '[Content_Types].xml': xmlHead + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '</Types>',
    '_rels/.rels': xmlHead + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml': xmlHead + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="通讯录" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': xmlHead + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
      '</Relationships>',
    'xl/sharedStrings.xml': xmlHead + sst,
    'xl/worksheets/sheet1.xml': xmlHead + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${sheetData}</sheetData></worksheet>`,
  }
}

/** Assemble a stored-deflate zip: local headers, central directory, EOCD. */
export function buildContactsXlsx(): ArrayBuffer {
  const strings: string[] = []
  // Order matters: the sheet fills the shared-string table, so sst is built from it afterwards.
  const sheetData = sheetXml(strings)
  const files = parts(strings, sheetData)

  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  const dosTime = 10 << 11
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 17

  for (const [name, xml] of Object.entries(files)) {
    const data = enc.encode(xml)
    const comp = new Uint8Array(deflateRawSync(data, { level: 9 }))
    const nameBuf = enc.encode(name)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBuf.length + comp.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 8, true)
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, comp.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBuf.length, true)
    local.set(nameBuf, 30)
    local.set(comp, 30 + nameBuf.length)
    locals.push(local)

    const cd = new Uint8Array(46 + nameBuf.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 8, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, comp.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBuf.length, true)
    cv.setUint32(42, offset, true)
    cd.set(nameBuf, 46)
    centrals.push(cd)
    offset += local.length
  }

  const cdSize = centrals.reduce((a, b) => a + b.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, Object.keys(files).length, true)
  ev.setUint16(10, Object.keys(files).length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const all = [...locals, ...centrals, eocd]
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0))
  let at = 0
  for (const p of all) { out.set(p, at); at += p.length }
  return out.buffer
}

