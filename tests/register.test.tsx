import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { BuiltinToolResults, On, ProcessRunResult, ToolCallResult } from 'claude-code'

type OkunanDosya = BuiltinToolResults['Read']
type MetinDosyasi = Extract<OkunanDosya, { type: 'text' }>['file']
type Karar = 'allow' | 'ask' | 'deny'

const CAGRI = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const UDF = '/belgeler/ornek.udf'
const METIN = 'ÖRNEK SULH HUKUK MAHKEMESİNE\n\nDAVACI\t: Ad SOYAD\nKONU\t: dilekçe örneğidir.'
const sablon = (icerik: string, ogeler = '') =>
  `<?xml version="1.0" encoding="UTF-8"?><template format_id="1.8"><content>${icerik}</content>` +
  `<properties><pageFormat mediaSizeName="1"/></properties><elements resolver="hvl-default">${ogeler}</elements></template>`
const XML = sablon(`<![CDATA[${METIN}]]>`)

/**
 * Gerçek Read'in bir .udf'ye verdiği cevap: uzantı ikili listesinde olmadığı
 * için araç zip'in ham baytlarını hatasız, metin gibi okur.
 */
const HAM = {
  result: {
    type: 'text',
    file: { filePath: UDF, content: 'PK\u0003\u0004', numLines: 1, startLine: 1, totalLines: 3 },
  },
  text: '     1\tPK\u0003\u0004',
} as ToolCallResult

const cikti = (stdout: string, ek: Partial<ProcessRunResult> = {}): ProcessRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
  ...ek,
})

const PANE = {
  plugin: 'udf-onizleme',
  component: 'Pane',
  requestId: 'udf',
  props: {
    title: 'UDF — ornek.udf',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

/**
 * Motorun yerine geçen bir oturum kurar: izin kararı, motorun zincirden döndürdüğü
 * cevap (varsayılan: gerçek Read'in ham bayt okuması), dosyanın varlığı ve
 * unzip'in çıktısı. unzip'e giden argv'leri ve zincire inen girdileri toplar.
 */
function kur(
  on: On,
  {
    xml = XML as string | ProcessRunResult,
    karar = 'allow' as Karar,
    zincir = HAM,
    varMi = true,
    tur = 'file' as 'file' | 'dir' | 'other',
    calistir = undefined as ((argv: readonly string[]) => ProcessRunResult | { deny: string }) | undefined,
    gercekler = undefined as string[] | undefined,
  } = {},
) {
  const argvler: (readonly string[])[] = []
  const inenler: Record<string, unknown>[] = []
  const sorulanlar: unknown[] = []

  on('tool.check', (_, e) => {
    sorulanlar.push(e)

    return { decision: karar, ...(karar === 'deny' ? { reason: 'Read(/belgeler/**) yasak' } : {}) }
  })
  on('tool.call', (_, e) => {
    inenler.push(e as Record<string, unknown>)

    // Gerçek Read gibi: metin sonucu girdideki yolu taşır.
    if (zincir === HAM) {
      const file = { ...(HAM.result as { file: object }).file, filePath: (e as { file_path?: unknown }).file_path }

      return { ...HAM, result: { ...(HAM.result as object), file } } as ToolCallResult
    }

    return zincir
  })
  on('fs.exists', () => ({ value: varMi }))

  let statSayisi = 0

  on('fs.stat', () => {
    const realPath = gercekler?.[Math.min(statSayisi++, gercekler.length - 1)]

    return { value: { kind: tur, size: 1, mtimeMs: 0, isLink: false, ...(realPath ? { realPath } : {}) } }
  })
  on('process.run', (_, e) => {
    argvler.push(e.argv)

    if (calistir) {
      const sonuc = calistir(e.argv)

      // { deny }: çağrı o gerekçeyle reddedilir (motorun zaman aşımı gibi).
      return 'deny' in sonuc ? sonuc : { value: sonuc }
    }

    return { value: typeof xml === 'string' ? cikti(xml) : xml }
  })

  return { argvler, inenler, sorulanlar }
}

/**
 * Araç çağrısı, aşırı yükleme çözümü atlanarak: `$.tool.call({ tool: 'Read', ... })`
 * doğrudan yazılınca tsc TS2589 (sonsuz derin tip) verir.
 */
const cagir = ($: Engine, girdi: { tool: string; [arguman: string]: unknown }) =>
  ($.tool.call as unknown as (g: typeof girdi) => Promise<ToolCallResult>)(girdi)

const oku = async ($: Engine, girdi: Record<string, unknown> & { file_path: string }) =>
  (await cagir($, { tool: 'Read', ...girdi })) as ToolCallResult<'Read'>

const dosyasi = (r: ToolCallResult<'Read'>): MetinDosyasi => {
  if (r.deny !== undefined || r.isError || r.result.type !== 'text') {
    throw new Error(`metin beklenirdi: ${JSON.stringify(r)}`)
  }

  return r.result.file
}

// ── Okuma ────────────────────────────────────────────────────────────────

test('Read bir .udf okuduğunda düz metin döner', async ($, on) => {
  kur(on)

  const r = await oku($, { file_path: UDF })
  const dosya = dosyasi(r)

  expect(dosya.content).toBe(METIN)
  expect(dosya.filePath).toBe(UDF)
  expect(dosya.totalLines).toBe(4)
  expect(dosya.startLine).toBe(1)
  expect(dosya.numLines).toBe(4)
  expect(r.context?.[0]).toContain('Write ya da Edit ile değiştirilemez')
})

test('büyük harfli .UDF uzantısı da yakalanır', async ($, on) => {
  kur(on)

  expect(dosyasi(await oku($, { file_path: '/belgeler/ORNEK.UDF' })).content).toBe(METIN)
})

test('offset ve limit 1 tabanlı satır aralığı verir', async ($, on) => {
  kur(on)

  const dosya = dosyasi(await oku($, { file_path: UDF, offset: 2, limit: 2 }))

  expect(dosya.content).toBe('\nDAVACI\t: Ad SOYAD')
  expect(dosya.startLine).toBe(2)
  expect(dosya.numLines).toBe(2)
  expect(dosya.totalLines).toBe(4)
})

test('offset 0, çekirdekteki gibi, baştan demektir', async ($, on) => {
  kur(on)

  const dosya = dosyasi(await oku($, { file_path: UDF, offset: 0, limit: 1 }))

  expect(dosya.content).toBe('ÖRNEK SULH HUKUK MAHKEMESİNE')
  expect(dosya.startLine).toBe(1)
})

test('sayı yerine metin olarak verilen offset ve limit, şemadaki gibi sayıya çevrilir', async ($, on) => {
  kur(on)

  const dosya = dosyasi(await oku($, { file_path: UDF, offset: '3', limit: '2' }))

  expect(dosya.content).toBe('DAVACI\t: Ad SOYAD\nKONU\t: dilekçe örneğidir.')
  expect(dosya.startLine).toBe(3)
})

test('offset dosyadan uzunsa boş dilim ve doğru toplam döner', async ($, on) => {
  kur(on)

  const dosya = dosyasi(await oku($, { file_path: UDF, offset: 10 }))

  expect(dosya.content).toBe('')
  expect(dosya.numLines).toBe(0)
  expect(dosya.startLine).toBe(10)
  expect(dosya.totalLines).toBe(4)
})

test('limit 0, negatif, null ya da ondalıklı girdi, araç çalışmadan reddedilir', async ($, on) => {
  const { argvler, inenler } = kur(on)

  for (const girdi of [{ limit: 0 }, { limit: -1 }, { limit: null }, { offset: 2.5 }, { offset: -1 }]) {
    expect((await oku($, { file_path: UDF, ...girdi })).deny).toContain('InputValidationError')
  }

  expect(argvler).toHaveLength(0)
  expect(inenler).toHaveLength(0)
})

test('CRLF ve tek CR, XML kuralı gereği LF olur', async ($, on) => {
  kur(on, { xml: sablon('<![CDATA[bir\r\niki\rüç]]>') })

  const dosya = dosyasi(await oku($, { file_path: UDF }))

  expect(dosya.content).toBe('bir\niki\nüç')
  expect(dosya.totalLines).toBe(3)
})

test('varlık olarak yazılmış CR de satır sonu sayılır', async ($, on) => {
  kur(on, { xml: sablon('bir&#13;iki') })

  expect(dosyasi(await oku($, { file_path: UDF })).totalLines).toBe(2)
})

test(']]> kaçışıyla bölünmüş CDATA birleşir', async ($, on) => {
  kur(on, { xml: sablon('<![CDATA[önce ]]]]><![CDATA[> sonra]]>') })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe('önce ]]> sonra')
})

test('CDATA yoksa düz metin varlıkları çözülerek okunur', async ($, on) => {
  kur(on, { xml: sablon('A &amp; B &lt;C&gt; &#x130;&#351;') })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe('A & B <C> İş')
})

test('content öncesindeki başka CDATA metin sanılmaz', async ($, on) => {
  kur(on, {
    xml:
      '<?xml version="1.0"?><template><properties><note><![CDATA[yanlış]]></note></properties>' +
      `<content><![CDATA[${METIN}]]></content></template>`,
  })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(METIN)
})

test('boş belge reddedilmez, boş metin döner', async ($, on) => {
  kur(on, { xml: sablon('<![CDATA[]]>') })

  const dosya = dosyasi(await oku($, { file_path: UDF }))

  expect(dosya.content).toBe('')
  expect(dosya.totalLines).toBe(0)
})

test('görsel, barkod ve boşluk nesnelerinin ¸ yer tutucuları silinir, metnin kendi ¸ işareti kalır', async ($, on) => {
  // 0: görsel, 5: barkod, 11: metnin kendi ¸'si (nesne yok), 13: boşluk nesnesi
  const metin = '¸baş¸ orta¸ ¸son'
  const ogeler =
    '<image startOffset="0" length="1"/><barcode length="1" startOffset="4"/>' +
    '<space startOffset="12" length="1"/><content startOffset="1" length="3"/>'

  kur(on, { xml: sablon(`<![CDATA[${metin}]]>`, ogeler) })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe('baş orta¸ son')
})

test('4 MiB kesiği metni yarıda bırakmışsa sessiz yarım metin değil, ret', async ($, on) => {
  kur(on, {
    xml: cikti(`<?xml version="1.0"?><template><content><![CDATA[${METIN}`, { isStdoutTruncated: true }),
  })

  expect((await oku($, { file_path: UDF })).deny).toContain('4 MiB')
})

test('kesik çıktıda metin tamamsa (resimler sonda) okunur', async ($, on) => {
  kur(on, { xml: cikti(XML.slice(0, -20), { isStdoutTruncated: true }) })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(METIN)
})

test('kesik çıktıda kesiğin ötesinde kalan görselin ¸ yer tutucusu da silinir', async ($, on) => {
  const tam = sablon(
    '<![CDATA[Önce ¸orta¸ son]]>',
    `<image imageData="${'A'.repeat(200)}" startOffset="5" length="1"/>` +
      `<image imageData="${'B'.repeat(200)}" startOffset="10" length="1"/>`,
  )

  kur(on, { xml: cikti(tam.slice(0, tam.indexOf('BBBB') + 50), { isStdoutTruncated: true }) })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe('Önce orta son')
})

test('tek tırnaklı ya da boşluklu startOffset tanınır; gerçek boşluğu gösteren nesne bir şey silmez', async ($, on) => {
  const ogeler = `<image startOffset='0' length='1'/><space startOffset = "4" length="1"/>`

  kur(on, { xml: sablon('<![CDATA[¸baş son]]>', ogeler) })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe('baş son')
})

test('limit yokken uzun belge satır önekiyle birlikte sınırda sayfalanır', async ($, on) => {
  const uzun = Array.from({ length: 2000 }, (_, i) => `${i + 1}. ${'x'.repeat(60)}`).join('\n')

  kur(on, { xml: sablon(`<![CDATA[${uzun}]]>`) })

  const r = await oku($, { file_path: UDF })
  const dosya = dosyasi(r)

  expect(dosya.truncatedByTokenCap).toBe(true)
  expect(dosya.numLines < 2000).toBe(true)
  // Modele giden: her satıra `    12\t` öneki (7) + satırın kendisi + satır sonu.
  expect(dosya.content.length + dosya.numLines * 7 <= 60_000).toBe(true)
  expect(dosya.totalLines).toBe(2000)
  expect(r.context?.[1]).toContain(`offset: ${dosya.numLines + 1}`)
})

test('allow_large bağlamın boş yarısına kadar verir', async ($, on) => {
  const uzun = Array.from({ length: 2000 }, (_, i) => `${i + 1}. ${'x'.repeat(60)}`).join('\n')

  kur(on, { xml: sablon(`<![CDATA[${uzun}]]>`) })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 0 }, rateLimits: [] },
  }))

  expect(dosyasi(await oku($, { file_path: UDF, allow_large: true })).numLines).toBe(2000)
})

test('aynı yanıttaki paralel allow_large okumaları bağlamın boş yarısını paylaşır', async ($, on) => {
  const uzun = Array.from({ length: 6000 }, (_, i) => `${i + 1}. ${'x'.repeat(60)}`).join('\n')

  kur(on, { xml: sablon(`<![CDATA[${uzun}]]>`) })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 100_000 }, rateLimits: [] },
  }))

  const okumalar = await Promise.all([1, 2, 3].map(() => oku($, { file_path: UDF, allow_large: true })))
  const [buyuk = 0, ...kalan] = okumalar
    .map(dosyasi)
    .map(d => d.content.length + d.numLines * 7)
    .sort((a, b) => b - a)

  // Boş alan 100 bin token; yarısı kabaca 125 bin karakter. Birincisi onu alır,
  // ötekiler normal bir sayfadan fazlasını alamaz.
  expect(buyuk > 60_000 && buyuk <= 125_000).toBe(true)
  expect(kalan.every(b => b <= 60_000)).toBe(true)
})

test('Read başka bir dosyayı okuduğunda zincir motora geçer', async ($, on) => {
  on('tool.call', () => ({
    result: { type: 'text', file: { filePath: '/belgeler/not.md', content: 'motor', numLines: 1, startLine: 1, totalLines: 1 } },
  }))

  expect(dosyasi(await oku($, { file_path: '/belgeler/not.md' })).content).toBe('motor')
})

// ── İzin ─────────────────────────────────────────────────────────────────

test('izin kuralı reddederse araç da unzip de hiç çalışmaz', async ($, on) => {
  const { argvler, inenler } = kur(on, { karar: 'deny' })

  expect((await oku($, { file_path: UDF })).deny).toContain('yasak')
  expect(argvler).toHaveLength(0)
  expect(inenler).toHaveLength(0)
})

test('izin verilse de zincir yürür: PreToolUse reddi metni engeller', async ($, on) => {
  const { argvler, inenler } = kur(on)

  // Kit PreToolUse'u bir oturumdaki gibi eklentinin altında yürütür; ret
  // { deny } değil, hata metni olarak döner ve motorun yerindeki hook'a inmez.
  on('classic.PreToolUse', () => ({ deny: 'müvekkil dosyası' }))

  const r = await oku($, { file_path: UDF })

  expect(r.isError).toBe(true)
  expect(r.isError && r.text).toContain('müvekkil dosyası')
  expect(argvler).toHaveLength(0)
  expect(inenler).toHaveLength(0)
})

test('metninde "binary file" geçen PreToolUse reddi de metni engeller', async ($, on) => {
  const { argvler } = kur(on)

  on('classic.PreToolUse', () => ({ deny: 'binary files are blocked in this folder' }))

  expect((await oku($, { file_path: UDF })).isError).toBe(true)
  expect(argvler).toHaveLength(0)
})

for (const [ad, text] of [
  [
    'diyalogda gerekçeli ret',
    "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nhayır, o binary file okunmasın",
  ],
  ['sınıflandırıcı reddi', 'Permission for this action has been denied. Reason: reading a binary file outside the project'],
  ['.udf ileride ikili listesine girerse', 'This tool cannot read binary files. The file appears to be a binary .udf file.'],
] as const) {
  test(`zincirden gelen hata metnine bakılmadan olduğu gibi döner: ${ad}`, async ($, on) => {
    const { argvler } = kur(on, { zincir: { isError: true, result: undefined, text } })

    const r = await oku($, { file_path: UDF })

    expect(r.isError && r.text).toContain('binary')
    expect(argvler).toHaveLength(0)
  })
}

test('PreToolUse okumayı başka dosyaya yönlendirirse özgün dosya açılmaz', async ($, on) => {
  const { argvler, inenler } = kur(on)

  on('classic.PreToolUse', () => ({ updatedInput: { file_path: '/izinli/karartilmis.udf', offset: 1, limit: 1 } }))

  const r = await oku($, { file_path: UDF })

  expect(r.deny).toContain('başka bir dosyaya yönlendirdi')
  expect(inenler[0]).toMatchObject({ file_path: '/izinli/karartilmis.udf' })
  expect(argvler).toHaveLength(0)
})

test('alttaki bir hook başka dosyanın sonucunu verirse özgün dosya açılmaz', async ($, on) => {
  const baska = {
    result: { type: 'text', file: { filePath: '/baska.udf', content: 'x', numLines: 1, startLine: 1, totalLines: 1 } },
    text: '     1\tx',
  } as ToolCallResult
  const { argvler } = kur(on, { zincir: baska })

  expect((await oku($, { file_path: UDF })).deny).toContain('başka bir dosyaya yönlendirdi')
  expect(argvler).toHaveLength(0)
})

test('bağ izinden sonra başka dosyaya çevrilirse açılmaz; değişmezse arşiv gerçek yoldan açılır', async ($, on) => {
  const { argvler } = kur(on, { gercekler: ['/gercek/ornek.udf', '/gizli/baska.udf'] })

  expect((await oku($, { file_path: UDF })).deny).toContain('başka bir dosyaya döndü')
  expect(argvler).toHaveLength(0)
})

test('bağ değişmezse arşiv çözülmüş gerçek yoldan açılır', async ($, on) => {
  const { argvler } = kur(on, { gercekler: ['/gercek/ornek.udf'] })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(METIN)
  expect(argvler[0]?.at(-2)).toBe('/gercek/ornek.udf')
})

test('macOS çekirdek yönlendirme yazımı (/.vol), .. ile gizlense de reddedilir', async ($, on) => {
  const { argvler, inenler } = kur(on)

  on('ui.open', () => ({ value: { isPlaced: true } }))

  for (const file_path of ['/.vol/16777234/2/belgeler/ornek.udf', '/tmp/../.file/id=1.2/ornek.udf']) {
    expect((await oku($, { file_path })).deny).toContain('çekirdeğin yönlendirdiği')
  }

  const calisan = await $.command.run({ command: 'udf', args: '/.resolve/1/2/ornek.udf', ...CAGRI })

  expect(calisan.exitCode).toBe(1)
  expect(inenler).toHaveLength(0)
  expect(argvler).toHaveLength(0)
})

test('Windows oturumunda Git Bash yazımı (/c/...) çekirdeğin açtığı sürücü yoluna çevrilir', async ($, on) => {
  const { argvler, inenler } = kur(on)

  on('session.cwd', () => ({ value: 'C:\\kasa' }))

  expect(dosyasi(await oku($, { file_path: '/c/Users/av/a.udf' })).content).toBe(METIN)
  expect(inenler[0]).toMatchObject({ file_path: 'C:\\Users\\av\\a.udf' })
  expect(argvler[0]?.at(-2)).toBe('C:\\Users\\av\\a.udf')
})

test('allow_large metin olarak "true" verilse de, şemadaki gibi, true sayılır', async ($, on) => {
  const uzun = Array.from({ length: 2000 }, (_, i) => `${i + 1}. ${'x'.repeat(60)}`).join('\n')

  kur(on, { xml: sablon(`<![CDATA[${uzun}]]>`) })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 0 }, rateLimits: [] },
  }))

  expect(dosyasi(await oku($, { file_path: UDF, allow_large: 'true' })).numLines).toBe(2000)
})

test('alt ajandaki allow_large ana döngünün bağlamına göre büyümez', async ($, on) => {
  const uzun = Array.from({ length: 2000 }, (_, i) => `${i + 1}. ${'x'.repeat(60)}`).join('\n')

  kur(on, { xml: sablon(`<![CDATA[${uzun}]]>`) })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 0 }, rateLimits: [] },
  }))

  const dosya = dosyasi(await oku($, { file_path: UDF, allow_large: true, agentId: 'a1' }))

  expect(dosya.numLines < 2000).toBe(true)
  expect(dosya.content.length + dosya.numLines * 7 <= 60_000).toBe(true)
})

test('zincire aynı dosyanın tek satırlık okuması iner; pages ve allow_large inmez', async ($, on) => {
  const { inenler } = kur(on)

  // Geçersiz bir pages, Read'in girdi denetiminde izinden önce bir hata ürettirirdi.
  const r = await oku($, { file_path: UDF, pages: 'binary file', allow_large: true })

  expect(dosyasi(r).content).toBe(METIN)
  expect(inenler).toHaveLength(1)
  expect(inenler[0]).toMatchObject({ file_path: UDF, offset: 1, limit: 1 })
  expect(Object.keys(inenler[0] ?? {}).filter(k => k === 'pages' || k === 'allow_large')).toEqual([])
})

test('dosya yoksa motorun kendi hatası olduğu gibi döner', async ($, on) => {
  const yok: ToolCallResult = { isError: true, result: undefined, text: 'File does not exist.' }

  kur(on, { zincir: yok })

  const r = await oku($, { file_path: UDF })

  expect(r.isError && r.text).toContain('does not exist')
})

test('izin de okuma da aynı mutlak yolla yapılır', async ($, on) => {
  const { sorulanlar, inenler, argvler } = kur(on)

  on('session.cwd', () => ({ value: '/kasa' }))

  dosyasi(await oku($, { file_path: './dosyalar/ornek.udf' }))

  expect(sorulanlar[0]).toMatchObject({ input: { file_path: '/kasa/dosyalar/ornek.udf' } })
  expect(inenler[0]).toMatchObject({ file_path: '/kasa/dosyalar/ornek.udf' })
  expect(argvler[0]?.at(-2)).toBe('/kasa/dosyalar/ornek.udf')
})

// ── Dosya biçimleri ve hatalar ──────────────────────────────────────────

test('unzip hata verirse Read sebebiyle reddedilir, ham zip okunmaz', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 11, stderr: 'caution: filename not matched:  content.xml' }) })

  expect((await oku($, { file_path: UDF })).deny).toContain('content.xml yok')
})

test('şifreli UDF parola istemeden, sebebi söylenerek reddedilir', async ($, on) => {
  const { argvler } = kur(on, { xml: cikti('', { exitCode: 82 }) })

  expect((await oku($, { file_path: UDF })).deny).toContain('parola korumalı')
  expect(argvler[0]?.slice(0, 4)).toEqual(['unzip', '-P', '', '-p'])
  expect(argvler).toHaveLength(1)
})

test('unzip süre aşımına düşerse tar denenmez, sebebi söylenir', async ($, on) => {
  const { argvler } = kur(on, {
    calistir: () => ({ deny: 'aborted: still running after 15000ms' }),
  })

  expect((await oku($, { file_path: UDF })).deny).toContain('saniyede açılamadı')
  expect(argvler.map(a => a[0])).toEqual(['unzip'])
})

for (const [ad, xml] of [
  ['kapanmayan <content açılışları', `<template>${'<content '.repeat(120_000)}`],
  ['kapanmayan CDATA açılışları', `<template>${'<![CDATA['.repeat(120_000)}`],
] as const) {
  test(`ayrıştırma doğrusal kalır: ${ad} hızla reddedilir`, async ($, on) => {
    kur(on, { xml })

    const t = Date.now()
    const r = await oku($, { file_path: UDF })

    expect(Date.now() - t < 1_000).toBe(true)
    expect(r.deny).toContain('metin bulunamadı')
  })
}

test('ayrıştırma doğrusal kalır: binlerce bildirimli dava dökümü hızla okunur', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({ value: `<dava><a>b</a>${'<!x>'.repeat(200_000)}</dava>` }))

  const t = Date.now()
  const dosya = dosyasi(await oku($, { file_path: UDF }))

  expect(Date.now() - t < 1_000).toBe(true)
  expect(dosya.content).toBe('dava\n  a: b')
})

test('metinde <elements yazısı geçse de öğe listesi içerikten sonra aranır', async ($, on) => {
  kur(on, { xml: sablon('<![CDATA[a¸ <elements> <image startOffset="1"/>]]>') })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe('a¸ <elements> <image startOffset="1"/>')
})

test('öğe listesi yoksa metindeki etikete benzer yazı nesne sayılmaz', async ($, on) => {
  kur(on, { xml: '<template><content><![CDATA[a¸ <image startOffset="1"/>]]></content></template>' })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe('a¸ <image startOffset="1"/>')
})

test('yol yoksa unzip hiç çalışmaz: joker kalıp başka dosyayı açamaz', async ($, on) => {
  const { argvler } = kur(on, { varMi: false })

  expect((await oku($, { file_path: '/belgeler/dava[12].udf' })).deny).toContain('bulunamadı')
  expect(argvler).toHaveLength(0)
})

test('klasör .udf adı taşısa da dosya değil diye reddedilir', async ($, on) => {
  const { argvler } = kur(on, { tur: 'dir' })

  expect((await oku($, { file_path: UDF })).deny).toContain('dosya değil')
  expect(argvler).toHaveLength(0)
})

test('unzip uyarıyla (1) çıksa da içerik geldiyse okunur', async ($, on) => {
  kur(on, { xml: cikti(XML, { exitCode: 1, stderr: '8 extra bytes at beginning' }) })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(METIN)
})

test('sıkıştırılmamış, düz XML olarak kaydedilmiş .udf de okunur', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({ value: XML }))

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(METIN)
})

test('UYAP dava dökümü (kökü <dava> olan düz XML) girintili bir ağaç olarak okunur', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({
    value:
      '<?xml version="1.0"?><dava><birim>Örnek Asliye Hukuk</birim><dosyabilgileri>' +
      '<esasNo>2026/1</esasNo><bos></bos></dosyabilgileri><konu>Alacak &amp; tazminat</konu></dava>',
  }))

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(
    'dava\n  birim: Örnek Asliye Hukuk\n  dosyabilgileri\n    esasNo: 2026/1\n  konu: Alacak & tazminat',
  )
})

test('dava dökümünde CDATA, nitelik, Türkçe etiket okunur; yorumdaki etiket okunmaz', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({
    value:
      '<?xml version="1.0"?><!-- <eski>Z</eski> --><dava><taraf rol="davacı"><ad><![CDATA[Ad <SOYAD>]]></ad></taraf>' +
      '<taraf rol="davalı"><ad>Diğer</ad></taraf><başlık>İlk</başlık><not a="1>2"/></dava>',
  }))

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(
    'dava\n  taraf (rol=davacı)\n    ad: Ad <SOYAD>\n  taraf (rol=davalı)\n    ad: Diğer\n  başlık: İlk\n  not (a=1>2)',
  )
})

test('dava dökümünde nitelikteki satır sonu satırı bölmez', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({ value: '<dava><taraf ad="Bir\nİki"/></dava>' }))

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe('dava\n  taraf (ad=Bir İki)')
})

test('kökten sonra öğe gelen XML dava dökümü sayılmaz', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({ value: '<dava><a>b</a></dava><dava><a>c</a></dava>' }))

  expect((await oku($, { file_path: UDF })).deny).toContain('metin bulunamadı')
})

test('aşırı derin dava dökümü yığını taşırmaz, sebebiyle reddedilir', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({ value: `<dava>${'<a>'.repeat(20_000)}x${'</a>'.repeat(20_000)}</dava>` }))

  expect((await oku($, { file_path: UDF })).deny).toContain('düzeyden derin')
})

test('içi boş dava dökümü boş belge sanılmaz, sebebiyle reddedilir', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({ value: '<?xml version="1.0"?><dava><birim></birim><taraf/></dava>' }))

  expect((await oku($, { file_path: UDF })).deny).toContain('dolu bir alan yok')
})

test('aslında PNG olan .udf ne olduğu söylenerek reddedilir', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', (_, e) =>
    e.as === 'bytes'
      ? { value: { base64: btoa('\x89PNG\r\n\x1a\n\0\0\0\r') } }
      : { value: '\x89PNG\r\n' },
  )

  expect((await oku($, { file_path: UDF })).deny).toContain('PNG')
})

test('unzip yoksa (Windows) zip okuyan tar ile açılır', async ($, on) => {
  const { argvler } = kur(on, {
    calistir: argv => {
      if (argv[0] === 'unzip') throw new Error('spawn unzip ENOENT')
      return cikti(XML)
    },
  })

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(METIN)
  expect(argvler.map(a => a[0])).toEqual(['unzip', 'tar'])
})

const unzipsiz = (tar: ProcessRunResult) => (argv: readonly string[]) => {
  if (argv[0] === 'unzip') throw new Error('spawn unzip ENOENT')
  return tar
}
const GNU_TAR = cikti('', {
  exitCode: 64,
  stderr: "tar: unrecognized option '--passphrase'\nTry 'tar --help' or 'tar --usage' for more information.\n",
})

test('unzip yoksa ve tar --passphrase\'i tanımıyorsa düz XML .udf yine okunur', async ($, on) => {
  const { argvler } = kur(on, { calistir: unzipsiz(GNU_TAR) })

  on('fs.read', () => ({ value: XML }))

  expect(dosyasi(await oku($, { file_path: UDF })).content).toBe(METIN)
  expect(argvler.map(a => a[0])).toEqual(['unzip', 'tar'])
})

test('unzip yoksa ve tar --passphrase\'i tanımıyorsa zip .udf şifreli sanılmaz', async ($, on) => {
  kur(on, { calistir: unzipsiz(GNU_TAR) })
  on('fs.read', () => ({ value: 'PK\u0003\u0004' }))

  const r = await oku($, { file_path: UDF })

  expect(r.deny).toContain('unzip ya da zip okuyabilen bir tar')
  expect(r.deny?.includes('parola korumalı')).toBe(false)
})

test('unzip yokken bsdtar şifreli arşivi tanırsa sebebi söylenir', async ($, on) => {
  kur(on, {
    calistir: unzipsiz(cikti('', { exitCode: 1, stderr: 'content.xml: Incorrect passphrase: Unknown error: -1\n' })),
  })

  expect((await oku($, { file_path: UDF })).deny).toContain('parola korumalı')
})

test('unzip yokken bsdtar arşivi açıp üyeyi bulamazsa sebep dosyadır, ortam değil', async ($, on) => {
  kur(on, { calistir: unzipsiz(cikti('', { exitCode: 1, stderr: 'tar: content.xml: Not found in archive\n' })) })
  on('fs.read', () => ({ value: 'PK\u0003\u0004' }))

  expect((await oku($, { file_path: UDF })).deny).toContain('arşivde content.xml yok')
})

test('unzip yokken bsdtar PNG\'yi açamazsa dosyanın ne olduğu söylenir', async ($, on) => {
  kur(on, { calistir: unzipsiz(cikti('', { exitCode: 1, stderr: 'tar: Unrecognized archive format\n' })) })
  on('fs.read', (_, e) =>
    e.as === 'bytes' ? { value: { base64: btoa('\x89PNG\r\n\x1a\n\0\0\0\r') } } : { value: '\x89PNG\r\n' },
  )

  expect((await oku($, { file_path: UDF })).deny).toContain('PNG')
})

test('ne unzip ne zip okuyan bir tar varsa model anlaşılır sebep okur', async ($, on) => {
  kur(on, {
    calistir: () => {
      throw new Error('spawn ENOENT')
    },
  })
  on('fs.read', () => ({ value: 'PK\u0003\u0004' }))

  expect((await oku($, { file_path: UDF })).deny).toContain('unzip ya da zip okuyabilen bir tar')
})

test('bayt isteğine metin dönse de tür tespiti çökmez, ret yine olur', async ($, on) => {
  kur(on, { xml: cikti('', { exitCode: 9 }) })
  on('fs.read', () => ({ value: 'ikili değil, metin' }))

  expect((await oku($, { file_path: UDF })).deny).toContain('geçerli bir zip arşivi değil')
})

// ── Yazma koruması ──────────────────────────────────────────────────────

test('Write, Edit ve NotebookEdit .udf dosyasını metinle ezemez', async ($, on) => {
  on('tool.call', () => ({ result: { type: 'create' } }))

  expect((await cagir($, { tool: 'Write', file_path: UDF, content: 'x' })).deny).toContain('UDF metin olarak yazılamaz')
  expect(
    (await cagir($, { tool: 'Edit', file_path: UDF, old_string: 'a', new_string: 'b' })).deny,
  ).toContain('UDF metin olarak yazılamaz')
  expect(
    (await cagir($, { tool: 'NotebookEdit', notebook_path: UDF, new_source: 'x' })).deny,
  ).toContain('UDF metin olarak yazılamaz')
  expect((await cagir($, { tool: 'Write', file_path: '/belgeler/not.md', content: 'x' })).deny).toBeUndefined()
})

test('motorun aynı .udf dosyasına çözdüğü yazımlar da reddedilir, benzer adlar değil', async ($, on) => {
  on('tool.call', () => ({ result: { type: 'create' } }))

  for (const yol of [`${UDF} `, `${UDF}\n`, `${UDF}\u00a0`, `${UDF}/.`, `${UDF}/x/..`, 'C:\\b\\a.UDF\\.', 'a.udf::$DATA', 'a.udf.']) {
    expect((await cagir($, { tool: 'Write', file_path: yol, content: 'x' })).deny).toContain('UDF metin olarak yazılamaz')
    expect(
      (await cagir($, { tool: 'Edit', file_path: yol, old_string: 'a', new_string: 'b' })).deny,
    ).toContain('UDF metin olarak yazılamaz')
    expect((await cagir($, { tool: 'NotebookEdit', notebook_path: yol, new_source: 'x' })).deny).toContain(
      'UDF metin olarak yazılamaz',
    )
  }

  for (const yol of ['/belgeler/a.udf.md', '/belgeler/a.udf/b.txt', '/belgeler/a.udfx', '/belgeler/a.udf/..']) {
    expect((await cagir($, { tool: 'Write', file_path: yol, content: 'x' })).deny).toBeUndefined()
  }
})

// ── /udf ve panel ───────────────────────────────────────────────────────

test('/udf yolu ~, tırnak, @ ve ters bölü kaçışından arındırıp mutlak verir', async ($, on) => {
  const { argvler } = kur(on)

  on('env.get', () => ({ value: '/Users/av' }))
  on('session.cwd', () => ({ value: '/kasa' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  for (const args of ['~/Belgeler/a.udf', '"/kasa/b c.udf"', '@d.udf', '/kasa/Dilekçe\\ v2.udf']) {
    await $.command.run({ command: 'udf', args, ...CAGRI })
  }

  expect(argvler.map(a => a.at(-2))).toEqual([
    '/Users/av/Belgeler/a.udf',
    '/kasa/b c.udf',
    '/kasa/d.udf',
    '/kasa/Dilekçe v2.udf',
  ])
})

test('/udf Windows yollarını (sürücü harfi, UNC, göreli) bozmaz', async ($, on) => {
  const { argvler } = kur(on)

  on('session.cwd', () => ({ value: '/kasa' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  for (const args of ['C:\\Belgeler\\a.udf', '\\\\sunucu\\pay\\b.udf', 'belgeler\\c.udf']) {
    await $.command.run({ command: 'udf', args, ...CAGRI })
  }

  expect(argvler.map(a => a.at(-2))).toEqual([
    'C:\\Belgeler\\a.udf',
    '\\\\sunucu\\pay\\b.udf',
    '/kasa/belgeler\\c.udf',
  ])
})

test('/udf, onay gereken yolu kişi yazdıysa açar, bir eklenti çalıştırdıysa açmaz', async ($, on) => {
  const { argvler } = kur(on, { karar: 'ask' })

  on('ui.open', () => ({ value: { isPlaced: true } }))

  const eklenti = { ...CAGRI, origin: { kind: 'plugin', name: 'baska' } } as unknown as typeof CAGRI
  const reddedilen = await $.command.run({ command: 'udf', args: UDF, ...eklenti })

  expect(reddedilen.text).toContain('kendiniz yazın')
  expect(argvler).toHaveLength(0)

  const acilan = await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  expect(acilan.text).toContain('ornek.udf açıldı')
})

test('/udf Windows oturumunda ayraçla başlayan klasör adını bozmaz', async ($, on) => {
  const { argvler } = kur(on)

  on('session.cwd', () => ({ value: 'C:\\kasa' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'udf', args: 'belgeler\\(2026)\\a.udf', ...CAGRI })

  expect(argvler[0]?.at(-2)).toBe('C:\\kasa/belgeler\\(2026)\\a.udf')
})

test('/udf, Read izin kuralının reddettiği yolu açmaz', async ($, on) => {
  const { argvler, sorulanlar } = kur(on, { karar: 'deny' })

  on('ui.open', () => ({ value: { isPlaced: true } }))

  const calisan = await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  expect(calisan.text).toContain('yasak')
  expect(calisan.exitCode).toBe(1)
  expect(sorulanlar).toHaveLength(1)
  expect(argvler).toHaveLength(0)
})

test('/udf dosyayı açar ve panel metni dört yüzeyde çizer', async ($, on) => {
  kur(on)
  on('command.register', () => ({ value: { command: 'udf' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const calisan = await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  expect(calisan.text).toContain('ornek.udf açıldı')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const baslik = await ui.find({ type: 'Text', text: /MAHKEMESİNE/ })

    expect(baslik?.text).toContain('ÖRNEK')
    await ui.unmount()
  }
})

test('panel bölümün tamamını çizer; kaydırmayı motor yapar, ağaç bodyRows ile kırpılmaz', async ($, on) => {
  const satirlar = Array.from({ length: 50 }, (_, i) => `satır ${i + 1}`)

  kur(on, { xml: sablon(`<![CDATA[${satirlar.join('\n')}]]>`) })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, scroll: { offset: 30, bodyRows: 5 } },
  })

  expect(await ui.findAll({ type: 'Text', text: /^satır \d+$/ })).toHaveLength(50)
  expect(await ui.find({ type: 'Button', key: 'sonraki' })).toBeUndefined()
  await ui.unmount()
})

for (const [ad, belge, beklenen] of [
  ['150 bin karakterlik', Array.from({ length: 3000 }, (_, i) => `${i + 1} ${'y'.repeat(46)}`).join('\n'), 2],
  ['25 bin satırlık', Array.from({ length: 25_000 }, (_, i) => `s${i + 1}`).join('\n'), 3],
  ['250 bin karakterlik tek satırlık', 'z'.repeat(250_000), 3],
] as const) {
  test(`${ad} belge motorun çizim sınırının altında bölümlere ayrılır, düğmeyle gezilir`, async ($, on) => {
    kur(on, { xml: sablon(`<![CDATA[${belge}]]>`) })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.scroll', () => ({}))

    const calisan = await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

    expect(calisan.text).toContain(`${beklenen} bölüm`)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })

      // Motor sınırı aşan ağacı çizmez; drawn() o zaman reddeder.
      await ui.drawn()
      expect((await ui.find({ type: 'Text', text: /bölüm 1\// }))?.text).toContain(`bölüm 1/${beklenen}`)
      expect(await ui.find({ type: 'Button', key: 'onceki' })).toBeUndefined()

      await ui.press({ key: 'sonraki' })
      await ui.drawn()
      expect((await ui.find({ type: 'Text', text: /bölüm 2\// }))?.text).toContain(`bölüm 2/${beklenen}`)
      expect(await ui.find({ type: 'Button', key: 'onceki' })).toBeDefined()

      await ui.press({ key: 'onceki' })
      await ui.unmount()
    }
  })
}

test('çizim yenilenmeden gelen iki basış iki bölüm ilerletir', async ($, on) => {
  kur(on, { xml: sablon(`<![CDATA[${Array.from({ length: 25_000 }, (_, i) => `s${i + 1}`).join('\n')}]]>`) })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))

  await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.drawn()
  await Promise.all([ui.press({ key: 'sonraki' }), ui.press({ key: 'sonraki' })])
  await ui.drawn()
  expect((await ui.find({ type: 'Text', text: /bölüm \d\// }))?.text).toContain('bölüm 3/3')
  await ui.unmount()
})

test('uzun satır vekil çiftinin ortasından bölünmez', async ($, on) => {
  const satir = `${'a'.repeat(9_999)}😀${'b'.repeat(10)}`

  kur(on, { xml: sablon(`<![CDATA[${satir}]]>`) })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const parcalar = await ui.findAll({ type: 'Text', text: /^[ab😀]+$/u })

  expect(parcalar.map(p => p.text)).toEqual(['a'.repeat(9_999), `😀${'b'.repeat(10)}`])
  await ui.unmount()
})

test('panel sekmeleri açar, denetim karakterlerini atar', async ($, on) => {
  kur(on, { xml: sablon('<![CDATA[DAVACI\t: Ad\u001b]0;başlık\u0007 SOYAD]]>') })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const satir = await ui.find({ type: 'Text', text: /DAVACI/ })

  expect(satir?.text).toBe('DAVACI  : Ad]0;başlık SOYAD')
  await ui.unmount()
})

test('açık paneldeyken ikinci /udf yeni belgeyi ilk bölümden çizer', async ($, on) => {
  let xml = XML

  on('tool.check', () => ({ decision: 'allow' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('process.run', () => ({ value: cikti(xml) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /MAHKEMESİNE/ })).toBeDefined()

  xml = sablon('<![CDATA[İKİNCİ BELGE]]>')
  await $.command.run({ command: 'udf', args: '/belgeler/ikinci.udf', ...CAGRI })

  expect(await ui.find({ type: 'Text', text: /İKİNCİ BELGE/ })).toBeDefined()
  await ui.unmount()
})

test('hiç dosya açılmadan panel yönergeyi gösterir', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const satir = await ui.find({ type: 'Text', text: /Henüz bir UDF/ })

  expect(satir?.text).toContain('/udf')
  await ui.unmount()
})

test('panel çizilemiyorsa /udf bunu söyler', async ($, on) => {
  kur(on)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'bağlı bir yüzey yok' } }))

  const calisan = await $.command.run({ command: 'udf', args: UDF, ...CAGRI })

  expect(calisan.text).toContain('bağlı bir yüzey yok')
})
