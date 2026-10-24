import { atom, read, update } from 'claude-code'
import type {
  BuiltinToolResults,
  EngineInterface,
  Register,
  ToolCallResult,
} from 'claude-code'

import type { UdfBelge } from '../types'

type OkunanDosya = BuiltinToolResults['Read']

const PANE = 'udf'

const belge = atom(
  { plugin: 'udf-onizleme', key: 'belge' } as const,
  null as UdfBelge,
)

/** UDF, içinde content.xml taşıyan bir zip; metin o dosyada CDATA içinde durur. */
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/

const kisaAd = (yol: string) => yol.split('/').pop() ?? yol

const udfMu = (yol: string) => yol.toLowerCase().endsWith('.udf')

/**
 * Zip'i açıp düz metni çıkarır. Modül ortamında DecompressionStream yok, bu
 * yüzden açma işi alt sürece veriliyor: `unzip -p` arşivi diske açmadan tek
 * üyeyi stdout'a yazar ve argv vektörü kullanıldığı için dosya adındaki boşluk
 * ya da Türkçe karakter sorun çıkarmaz.
 */
async function udfMetni($: EngineInterface, yol: string): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(
    ['unzip', '-p', yol, 'content.xml'],
    { timeoutMs: 15000 },
  )

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `unzip ${exitCode} ile çıktı`)
  }

  const bulunan = CDATA.exec(stdout)

  if (!bulunan?.[1]) {
    throw new Error('content.xml içinde metin bulunamadı')
  }

  return bulunan[1]
}

export const register: Register = on => {
  // Read bir .udf okuduğunda zincir burada biter: gerçek araç hiç çalışmaz,
  // onun yerine zip'ten çıkan düz metin Read'in kendi çıktı şemasıyla döner.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (!udfMu(e.file_path)) {
      return next(e)
    }

    const tamMetin = await udfMetni($, e.file_path)
    const satirlar = tamMetin.split('\n')
    const basla = Math.max(1, e.offset ?? 1)
    const son = e.limit === undefined ? undefined : basla - 1 + e.limit
    const dilim = satirlar.slice(basla - 1, son)

    const okunan: OkunanDosya = {
      type: 'text',
      file: {
        filePath: e.file_path,
        content: dilim.join('\n'),
        numLines: dilim.length,
        startLine: basla,
        totalLines: satirlar.length,
      },
    }

    const cevap: ToolCallResult<'Read'> = { result: okunan }

    return cevap
  }).catch(($, e, next) =>
    // Açma başarısızsa gerçek Read'e düşmek ham zip baytlarını okutur; bunun
    // yerine sebebi söyleyip duruyoruz.
    next.called
      ? next(e)
      : { deny: `${$.plugin.name}: ${kisaAd(e.file_path)} açılamadı.` },
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'udf',
      description: 'Bir UDF dosyasını metin olarak panelde açar',
      argumentHint: '<dosya yolu>',
    })

    return next(e)
  })

  on('command.run', { command: 'udf' }, async ($, e) => {
    const yol = e.args.trim().replace(/^['"]|['"]$/g, '')

    if (!yol) {
      const acik = await read($, belge)

      if (!acik) {
        return { text: 'Kullanım: /udf <dosya.udf yolu>' }
      }

      await $.ui.open({ id: PANE, title: `UDF — ${kisaAd(acik.yol)}` })

      return { text: `${kisaAd(acik.yol)} yeniden açıldı.` }
    }

    if (!udfMu(yol)) {
      return { text: `${kisaAd(yol)} bir .udf dosyası değil.`, exitCode: 1 }
    }

    try {
      const metin = await udfMetni($, yol)
      const satir = metin.split('\n').length

      await update($, belge, () => ({ yol, metin, satir }))
      await $.ui.open({ id: PANE, title: `UDF — ${kisaAd(yol)}` })

      return { text: `${kisaAd(yol)} açıldı: ${satir} satır, ${metin.length} karakter.` }
    } catch (hata) {
      const sebep = hata instanceof Error ? hata.message : String(hata)

      return { text: `${kisaAd(yol)} açılamadı: ${sebep}`, exitCode: 1 }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const acik = await read($, belge)

    if (!acik) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Henüz bir UDF açılmadı. /udf &lt;dosya yolu&gt;</Text>
        </Box>
      )
    }

    const satirlar = acik.metin.split('\n')
    const yer = Math.max(1, (e.props.scroll?.bodyRows ?? 24) - 2)
    const kaydirma = Math.min(
      Math.max(0, e.props.scroll?.offset ?? 0),
      Math.max(0, satirlar.length - 1),
    )
    const gorunen = satirlar.slice(kaydirma, kaydirma + yer)

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {kisaAd(acik.yol)} · {satirlar.length} satır
        </Text>
        {gorunen.map(satir => (
          <Text>{satir === '' ? ' ' : satir}</Text>
        ))}
      </Box>
    )
  })
}
