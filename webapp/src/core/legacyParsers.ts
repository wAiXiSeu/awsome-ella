/**
 * Parsers ported from the single-file app (`index.html:106-133`) so data imported there keeps
 * parsing identically here. Two deliberate differences from the reference, both documented in the
 * plan: XML is read by a small tag scanner instead of `DOMParser` (so the identical code path runs
 * in the node test environment and in the browser), and `xlsxToSheets` returns every sheet.
 */

/** Quote/tab semantics identical to `parseCSV` at index.html:106. */
export function parseCsv(text: string): string[][] {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim())
  return lines.map(line => {
    const cells: string[] = []
    let cur = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q
      } else if ((ch === ',' || ch === '\t') && !q) {
        cells.push(cur.trim()); cur = ''
      } else cur += ch
    }
    cells.push(cur.trim())
    return cells
  })
}

function colToNum(col: string): number {
  let n = 0
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64)
  return n
}

const LENS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTS = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const FIXED_LEN: number[] = []
for (let i = 0; i < 144; i++) FIXED_LEN.push(8)
for (let i = 144; i < 256; i++) FIXED_LEN.push(9)
for (let i = 256; i < 280; i++) FIXED_LEN.push(7)
for (let i = 280; i < 288; i++) FIXED_LEN.push(8)
const FIXED_DIST: number[] = []
for (let i = 0; i < 30; i++) FIXED_DIST.push(5)
const MAX_OUT = 50000000

/**
 * DEFLATE raw inflater, ported one-for-one from `inflateRaw` (index.html:112-123).
 * Exported for tests: in production it is the fallback for platforms without `DecompressionStream`,
 * so the browser fast path and the node fast path would otherwise leave this code unexercised.
 */
export function inflateRaw(data: Uint8Array): Uint8Array | null {
  let pos = 0, bb = 0, bc = 0, eof = false
  const out: number[] = []

  function bits(n: number): number {
    while (bc < n) {
      if (pos >= data.length) { eof = true; return 0 }
      bb |= data[pos++] << bc
      bc += 8
    }
    const v = bb & ((1 << n) - 1)
    bb >>>= n
    bc -= n
    return v
  }

  function construct(cnt: number[], sym: number[], lengths: number[], n: number): number {
    const offs: number[] = []
    for (let z = 0; z < 17; z++) offs.push(0)
    let left = 1
    for (let i = 0; i <= 15; i++) cnt[i] = 0
    for (let i = 0; i < n; i++) cnt[lengths[i]]++
    if (cnt[0] === n) return 0
    for (let i = 1; i <= 15; i++) { left <<= 1; left -= cnt[i]; if (left < 0) return left }
    offs[1] = 0
    for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + cnt[i]
    for (let i = 0; i < n; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i
    return left
  }

  function huffDecode(cnt: number[], sym: number[]): number {
    let code = 0, first = 0, index = 0
    for (let len = 1; len <= 15; len++) {
      code |= bits(1)
      const c = cnt[len]
      if (code - c < first) return sym[index + (code - first)]
      index += c; first += c; first <<= 1; code <<= 1
    }
    return -1
  }

  function codes(lcnt: number[], lsym: number[], dcnt: number[], dsym: number[]): number {
    for (;;) {
      if (eof) return 0
      let sym = huffDecode(lcnt, lsym)
      if (sym < 0) return sym
      if (sym === 256) return 0
      if (sym < 256) out.push(sym)
      else {
        sym -= 257
        if (sym >= 29) return -2
        let len = LENS[sym] + bits(LEXT[sym])
        sym = huffDecode(dcnt, dsym)
        if (sym < 0) return sym
        const dist = DISTS[sym] + bits(DEXT[sym])
        let k = out.length - dist
        while (len--) out.push(out[k++])
      }
      if (out.length > MAX_OUT) return -2
    }
  }

  const lcnt: number[] = [], lsym: number[] = [], dcnt: number[] = [], dsym: number[] = []
  for (let z = 0; z < 16; z++) { lcnt.push(0); dcnt.push(0) }
  for (let z = 0; z < 288; z++) lsym.push(0)
  for (let z = 0; z < 30; z++) dsym.push(0)

  let last = 0
  while (!last && !eof) {
    last = bits(1)
    const type = bits(2)
    if (type === 0) {
      bb = 0; bc = 0
      let slen = bits(16)
      bits(16)
      while (slen--) out.push(data[pos++])
    } else if (type === 1) {
      construct(lcnt, lsym, FIXED_LEN, 288)
      construct(dcnt, dsym, FIXED_DIST, 30)
      if (codes(lcnt, lsym, dcnt, dsym) < 0) return null
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
      const ll: number[] = []
      for (let o = 0; o < 19; o++) ll.push(0)
      for (let o = 0; o < ncode; o++) ll[order[o]] = bits(3)
      if (construct(lcnt, lsym, ll, 19)) return null
      const lengths: number[] = []
      let idx = 0
      while (idx < nlen + ndist) {
        const sym = huffDecode(lcnt, lsym)
        if (sym < 0) return null
        if (sym < 16) lengths[idx++] = sym
        else {
          let cl = 0, cc = 0
          if (sym === 16) { if (idx === 0) return null; cl = lengths[idx - 1]; cc = 3 + bits(2) }
          else if (sym === 17) { cl = 0; cc = 3 + bits(3) }
          else { cl = 0; cc = 11 + bits(7) }
          if (idx + cc > nlen + ndist) return null
          while (cc--) lengths[idx++] = cl
        }
      }
      if (!lengths[256]) return null
      if (construct(lcnt, lsym, lengths, nlen)) return null
      if (construct(dcnt, dsym, lengths.slice(nlen), ndist)) return null
      if (codes(lcnt, lsym, dcnt, dsym) < 0) return null
    } else return null
  }
  return new Uint8Array(out)
}

/**
 * Fast path: the platform's own `deflate-raw` decoder (index.html:124). If it is missing or stalls,
 * fall back to the ported `inflateRaw` above, exactly like the original.
 */
async function inflateRawBytes(cd: Uint8Array<ArrayBuffer>): Promise<Uint8Array | null> {
  const G = globalThis as unknown as {
    DecompressionStream?: new (format: string) => unknown
    Blob?: typeof Blob
    Response?: { new (body: unknown): { arrayBuffer(): Promise<ArrayBuffer> } }
  }
  if (G.DecompressionStream && G.Blob && G.Response) {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const ds = new G.DecompressionStream('deflate-raw') as { writable: unknown; readable: unknown }
      const stream = (new Blob([cd]) as unknown as { stream(): { pipeThrough(x: unknown): unknown } }).stream()
        .pipeThrough(ds as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      const ab = await new Promise<ArrayBuffer | null>((res, rej) => {
        timer = setTimeout(() => res(null), 8000)
        new G.Response!(stream).arrayBuffer().then(v => res(v), rej)
      })
      if (ab) return new Uint8Array(ab)
    } catch {
      /* fall through to the manual inflate */
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
  try { return inflateRaw(cd) } catch { return null }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g: string) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[g.toLowerCase()] ?? m
  })
}

/** Attribute map of a tag's attribute text (`<c r="B2" t="s">` -> { r: 'B2', t: 's' }). */
function attrsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '')
  return out
}

function textsOf(body: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out.push(decodeEntities(m[1]))
  return out
}

/** Sheet XML -> rows, same cell/column/empty-row semantics as `parseSheetXml` (index.html:130). */
function parseSheetRows(xml: string, shared: string[]): string[][] {
  const result: string[][] = []
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(xml))) {
    const body = rm[2] ?? ''
    const arr: string[] = []
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm: RegExpExecArray | null
    while ((cm = cellRe.exec(body))) {
      const a = attrsOf(cm[1])
      const inner = cm[2] ?? ''
      const colN = colToNum((a.r ?? '').replace(/[0-9]/g, ''))
      if (colN < 1) continue
      while (arr.length < colN - 1) arr.push('')
      let val = ''
      const v = textsOf(inner, 'v')
      if (v.length) val = v[0]
      else {
        const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)
        if (is) val = textsOf(is[1], 't').join('')
      }
      if (a.t === 's' && val !== '') {
        const idx = parseInt(val)
        val = shared[idx] != null ? shared[idx] : ''
      }
      arr[colN - 1] = val
    }
    if (arr.some(cell => String(cell).trim() !== '')) result.push(arr)
  }
  return result
}

export interface Sheet { name: string; rows: string[][] }

/**
 * xlsx reader ported from `parseXlsx` (index.html:125-133): EOCD -> central directory -> per-entry
 * inflate -> workbook/rels sheet list -> shared strings -> sheet rows. Returns every sheet, which is
 * what the original's unused `allSheets` parameter was for.
 */
export async function xlsxToSheets(buf: ArrayBuffer): Promise<Sheet[]> {
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  let eocd = -1
  const start = Math.max(0, bytes.length - 22 - 65536)
  for (let i = bytes.length - 22; i >= start; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的xlsx文件')
  const cdOffset = view.getUint32(eocd + 16, true)
  const cdCount = view.getUint16(eocd + 10, true)

  interface Entry { name: string; method: number; compSize: number; ds: number }
  const items: Entry[] = []
  let p = cdOffset
  for (let k = 0; k < cdCount; k++) {
    if (bytes[p] !== 0x50 || bytes[p + 1] !== 0x4b || bytes[p + 2] !== 0x01 || bytes[p + 3] !== 0x02) break
    const method = view.getUint16(p + 10, true)
    const compSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const lho = view.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    const lNameLen = view.getUint16(lho + 26, true)
    const lExtraLen = view.getUint16(lho + 28, true)
    items.push({ name, method, compSize, ds: lho + 30 + lNameLen + lExtraLen })
    p += 46 + nameLen + extraLen + commentLen
  }

  const entries: Record<string, Uint8Array> = {}
  await Promise.all(items.map(async it => {
    const cd = bytes.subarray(it.ds, it.ds + it.compSize)
    if (it.method === 0) entries[it.name] = cd
    else {
      const inflated = await inflateRawBytes(cd)
      if (inflated) entries[it.name] = inflated
    }
  }))

  const decode = (u: Uint8Array): string => new TextDecoder().decode(u)

  // Sheet list: workbook.xml + its rels, falling back to numbered worksheet paths.
  let sheetPaths: { name: string; path: string }[] = []
  const wb = entries['xl/workbook.xml']
  if (wb) {
    const relMap: Record<string, string> = {}
    const rels = entries['xl/_rels/workbook.xml.rels']
    if (rels) {
      const relRe = /<Relationship\b([^>]*?)\/>/g
      let rlm: RegExpExecArray | null
      while ((rlm = relRe.exec(decode(rels)))) {
        const a = attrsOf(rlm[1])
        if (a.Id) relMap[a.Id] = a.Target
      }
    }
    const sheetRe = /<sheet\b([^>]*?)\/>/g
    let sm: RegExpExecArray | null
    let n = 0
    while ((sm = sheetRe.exec(decode(wb)))) {
      const a = attrsOf(sm[1])
      let tgt = relMap[a['r:id'] ?? a['id'] ?? ''] ?? null
      if (tgt) {
        if (!tgt.startsWith('/')) tgt = 'xl/' + tgt.replace(/^\.\//, '')
        sheetPaths.push({ name: a.name || `Sheet${n + 1}`, path: tgt })
      }
      n++
    }
  }
  if (!sheetPaths.length) {
    for (let sp = 1; entries[`xl/worksheets/sheet${sp}.xml`]; sp++) {
      sheetPaths.push({ name: `Sheet${sp}`, path: `xl/worksheets/sheet${sp}.xml` })
    }
  }

  const shared: string[] = []
  const ss = entries['xl/sharedStrings.xml']
  if (ss) {
    const siRe = /<si\b([^>]*?)(?:\/>|>([\s\S]*?)<\/si>)/g
    let sim: RegExpExecArray | null
    while ((sim = siRe.exec(decode(ss)))) shared.push(textsOf(sim[2] ?? '', 't').join(''))
  }

  const outSheets: Sheet[] = []
  for (const sp of sheetPaths) {
    const sx = entries[sp.path]
    if (!sx) continue
    try {
      const rows = parseSheetRows(decode(sx), shared)
      if (rows.length) outSheets.push({ name: sp.name, rows })
    } catch { /* a sheet that will not read is skipped, as in the original */ }
  }
  if (!outSheets.length) throw new Error('未找到工作表数据')
  return outSheets
}

