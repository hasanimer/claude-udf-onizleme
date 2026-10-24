import { expect, test } from 'claude-code/testing'
import type { BuiltinToolResults } from 'claude-code'

type OkunanDosya = BuiltinToolResults['Read']

const CAGRI = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const UDF = '/belgeler/ornek.udf'
const METIN = 'ÖRNEK SULH HUKUK MAHKEMESİNE\n\nDAVACI\t: Ad SOYAD\nKONU\t: dilekçe örneğidir.'
const XML = `<?xml version="1.0"?><template><content><![CDATA[${METIN}]]></content></template>`

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

test('Read bir .udf okuduğunda düz metin döner', async ($, on) => {
  on('process.run', () => ({
    value: { exitCode: 0, stdout: XML, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  const okunan = await $.tool.call({ tool: 'Read', file_path: UDF })
  const dosya = okunan.result as OkunanDosya

  expect(dosya.type).toBe('text')
  expect(dosya.type === 'text' && dosya.file.content).toBe(METIN)
  expect(dosya.type === 'text' && dosya.file.filePath).toBe(UDF)
  expect(dosya.type === 'text' && dosya.file.totalLines).toBe(4)
})

test('Read başka bir dosyayı okuduğunda zincir motora geçer', async ($, on) => {
  on('tool.call', () => ({
    result: { type: 'text', file: { filePath: '/belgeler/not.md', content: 'motor', numLines: 1, startLine: 1, totalLines: 1 } },
  }))

  const okunan = await $.tool.call({ tool: 'Read', file_path: '/belgeler/not.md' })
  const dosya = okunan.result as OkunanDosya

  expect(dosya.type === 'text' && dosya.file.content).toBe('motor')
})

test('unzip hata verirse Read reddedilir, ham zip okunmaz', async ($, on) => {
  on('process.run', () => ({
    value: { exitCode: 9, stdout: '', stderr: 'cannot find zipfile directory', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  const okunan = await $.tool.call({ tool: 'Read', file_path: UDF })

  expect(okunan.deny).toContain('ornek.udf')
})

test('/udf dosyayı açar ve panel metni çizer', async ($, on) => {
  on('process.run', () => ({
    value: { exitCode: 0, stdout: XML, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
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

test('hiç dosya açılmadan panel yönergeyi gösterir', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const satir = await ui.find({ type: 'Text', text: /Henüz bir UDF/ })

  expect(satir?.text).toContain('/udf')
  await ui.unmount()
})
