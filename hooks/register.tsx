import { atom, read, update } from 'claude-code'
import type {
  BuiltinToolResults,
  EngineInterface,
  Register,
  ToolCallResult,
} from 'claude-code'

type OkunanDosya = BuiltinToolResults['Read']

/** /udf ile açılan belge, panelde çizileceği hâliyle. */
type AcikBelge = {
  /** Dosyanın mutlak yolu. */
  yol: string
  /**
   * Panelde çizilecek satırlar: LF'ye indirgenmiş, sekmeleri açılmış, denetim
   * karakterleri ayıklanmış, 10.000 karakterden uzun satırları parçalanmış.
   */
  satirlar: string[]
  /** Bölümlerin `satirlar` içindeki başlangıç indeksleri. */
  bolumler: number[]
  /** Belgenin satır sayısı (parçalanmadan önce). */
  satir: number
}

/** Bağlamın doluluğu, token olarak: allow_large'ın sınırı buna göre konur. */
type Baglam = { window: number; tokens: number }

/** Aynı model yanıtındaki allow_large okumalarının harcadığı karakterler. */
type Defter = { tokens: number; harcanan: number }

const PANE = 'udf'

const ACMA_SURESI = 15_000

/**
 * Read'in bir çağrıda döndüreceği en fazla karakter, satır numarası önekiyle
 * birlikte. Türkçede kabaca 2,5–3 karakter bir token eder; bu, gerçek Read'in
 * token sınırının altında kalır.
 */
const SAYFA = 60_000

/** Bir tokenın kabaca karakter karşılığı; SAYFA'nın da varsayımı. */
const KARAKTER_TOKEN = 2.5

/** Read'in modele giden her satırın başına koyduğu `    12\t` öneki. */
const ONEK = 8

/**
 * Motor bir çizimde en çok 100.000 karakter ya da 20.000 düğüm (satır başına
 * iki) çizer ve aşan ağacı hiç çizmez. Bölümler bu sınırların altında tutulur.
 */
const BOLUM_KARAKTER = 90_000
const BOLUM_SATIR = 9_000

/** Panelde tek satırın en fazla uzunluğu; uzun satır bu boyda parçalanır. */
const PARCA = 10_000

/**
 * Adı .udf ile biten yol. Read hook'unun kaydı aynı ifadeyi, yazma hook'larınınki
 * `.udf` geçen her yolu satır içinde yazar: hook'lar yalnız bu yollarda çağrılır
 * ve `claude plugin validate` kapıyı özetinde gösterir.
 */
const UDF_YOLU = /\.udf$/i

/**
 * Oturum durumunda yalnız paneli yeniden çizdiren bir sayaç ve açık bölüm
 * durur. Durumu her eklenti okuyabilir; belgenin metni ve yolu oraya yazılmaz.
 */
const surum = atom({ plugin: 'udf-onizleme', key: 'surum' } as const, 0)

const bolum = atom({ plugin: 'udf-onizleme', key: 'bolum' } as const, 0)

const kisaAd = (yol: string) => yol.split(/[\\/]/).pop() || yol

const udfMu = (yol: unknown): yol is string => typeof yol === 'string' && UDF_YOLU.test(yol)

/**
 * Bir yazma aracı bu yola yazınca hangi adlı dosyaya yazar. Motor yolu JS
 * trim'iyle kırpıp normalleştirir: `x.udf `, `x.udf\n`, `x.udf/.` ve
 * `x.udf/a/..` aynı dosyaya iner. Windows adın sonundaki nokta ve boşluğu
 * atar; `x.udf::$DATA` de aynı dosyadır. Fazladan ret zararsız, eksik ret değil.
 */
function udfeYazar(yol: unknown): boolean {
  if (typeof yol !== 'string') {
    return false
  }

  const parcalar: string[] = []

  for (const parca of yol.trim().split(/[\\/]+/)) {
    if (parca === '..') {
      parcalar.pop()
    } else if (parca !== '' && parca !== '.') {
      parcalar.push(parca)
    }
  }

  return (parcalar.pop() ?? '').split(':').some(ad => UDF_YOLU.test(ad.replace(/[\s.]+$/, '')))
}

/**
 * macOS çekirdeğinin yerel bir dosyaya yönlendirdiği kök yazımlar (`/.vol`,
 * `/.file`, `/.nofollow`, `/.resolve`). Claude Code'un dosya arayüzü bunları ağ
 * konumu sayıp reddeder; gerçek yol çözülemez, bağ denetimi körleşir.
 */
function cekirdekYonlendirmesi(yol: string): boolean {
  const parcalar: string[] = []

  // `/tmp/../.vol/...` gibi bir yazım da köke iner; bölümler çözülerek bakılır.
  for (const parca of yol.split(/[\\/]+/)) {
    if (parca === '..') {
      parcalar.pop()
    } else if (parca !== '' && parca !== '.') {
      parcalar.push(parca)
    }
  }

  return /^[\\/]/.test(yol) && /^\.(?:vol|file|nofollow|resolve)$/i.test(parcalar[0] ?? '')
}

/** Kişinin kendi eliyle yazdığı sayılan komut kökenleri. */
const KISI_KOKENI = new Set(['composer', 'bridge', 'sdk', 'auto-continuation', 'slack-ping'])

const mesaj = (hata: unknown) => (hata instanceof Error ? hata.message : String(hata))

const SIFRELI = 'arşiv parola korumalı (şifreli); UDF şifresiz kaydedilmeli'

const UDF_YAZILMAZ =
  'UDF metin olarak yazılamaz ya da düzenlenemez: dosya bir zip arşivi (çoğu zaman ' +
  'e-imza paketiyle birlikte) ya da UYAP XML\'i; düz metinle üzerine yazılırsa belge ' +
  'bozulur. Yeni bir UDF için UDF üreten bir araç kullanılmalı.'

/** XML'in önceden tanımlı ve sayısal karakter varlıklarını çözer. */
const ADLI: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

const varliklariCoz = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (tam, ad: string) => {
    if (!ad.startsWith('#')) return ADLI[ad] ?? tam
    const kod = ad[1] === 'x' ? parseInt(ad.slice(2), 16) : parseInt(ad.slice(1), 10)
    return kod > 0 && kod <= 0x10ffff ? String.fromCodePoint(kod) : tam
  })

/**
 * İlk `<content>` açılış etiketinin bittiği yer ve kendiliğinden kapanıp
 * kapanmadığı. Düzenli ifadeyle aranmaz: `>` hiç gelmeyen her `<content `
 * konumunda belgenin sonuna gidip geri izler, uydurma bir belgede süre
 * boyutun karesiyle büyürdü.
 */
function icerikAcilisi(xml: string): { son: number; bos: boolean } | null {
  for (let i = xml.indexOf('<content'); i >= 0; i = xml.indexOf('<content', i + 8)) {
    const c = xml[i + 8] ?? ''

    if (c === '>') return { son: i + 9, bos: false }
    if (c === '/' && xml[i + 9] === '>') return { son: i + 10, bos: true }

    if (/\s/.test(c)) {
      const kapa = xml.indexOf('>', i + 9)

      // Bu etiket kapanmıyorsa ötesinde kapanan bir `<content` da yoktur.
      return kapa < 0 ? null : { son: kapa + 1, bos: xml[kapa - 1] === '/' }
    }
  }

  return null
}

/**
 * `<content>` öğesinin metni: CDATA bölümleri olduğu gibi, aradaki düz metin
 * varlıkları çözülerek, belge sırasıyla birleşir. Metinde `]]>` geçince
 * yazıcılar CDATA'yı böler (`]]]]><![CDATA[>`); birleştirme onu geri kurar.
 *
 * null: öğe yok. `kapandi` false: öğe kapanmadan çıktı bitti (kesik ya da bozuk).
 * `bitis`: öğenin kapandığı yerin sonu.
 */
function icerikMetni(xml: string): { metin: string; kapandi: boolean; bitis: number } | null {
  const acilis = icerikAcilisi(xml)

  if (!acilis) {
    return null
  }

  if (acilis.bos) {
    return { metin: '', kapandi: true, bitis: acilis.son }
  }

  let metin = ''
  let i = acilis.son

  while (i < xml.length) {
    if (xml.startsWith('<![CDATA[', i)) {
      const son = xml.indexOf(']]>', i + 9)

      if (son < 0) {
        return { metin, kapandi: false, bitis: i }
      }

      metin += xml.slice(i + 9, son)
      i = son + 3
    } else if (xml.startsWith('<!--', i)) {
      const son = xml.indexOf('-->', i + 4)

      if (son < 0) {
        return { metin, kapandi: false, bitis: i }
      }

      i = son + 3
    } else if (/^<\/content\s*>/.test(xml.slice(i, i + 32))) {
      return { metin, kapandi: true, bitis: xml.indexOf('>', i) + 1 }
    } else if (xml[i] === '<') {
      // İçeride beklenmeyen bir etiket: etiketin kendisi atlanır, metni kalır.
      const son = xml.indexOf('>', i + 1)

      if (son < 0) {
        return { metin, kapandi: false, bitis: i }
      }

      i = son + 1
    } else {
      const son = xml.indexOf('<', i)

      metin += varliklariCoz(son < 0 ? xml.slice(i) : xml.slice(i, son))

      if (son < 0) {
        return { metin, kapandi: false, bitis: i }
      }

      i = son
    }
  }

  return { metin, kapandi: false, bitis: i }
}

/**
 * UDF her gömülü görsel ve barkod için metne tek bir U+00B8 (`¸`) yer tutucu
 * koyar; nesne `<elements>` altında o ofseti gösterir. Boşluk (`space`)
 * nesnelerinin çoğu ise metindeki gerçek bir boşluğu gösterir. Bu yüzden yalnız
 * bir nesnenin ofsetinde duran ve gerçekten `¸` olan karakter silinir; metnin
 * kendi `¸`'si (başka dillerdeki çengel) korunur. Ofsetler UTF-16 birimidir.
 *
 * `kesik`: content.xml 4 MiB'de kesildi, öğe listesi yarım. Öğeler belge
 * sırasıyla yazılır; görünen son öğenin bittiği yerden sonraki her `¸`,
 * kesiğin ötesinde kalan bir nesnenin yer tutucusu sayılır.
 */
function yerTutuculariSil(metin: string, xml: string, icerikSonu: number, kesik: boolean): string {
  const konumlar: number[] = []
  // Metin gövdesindeki etikete benzer bir yazı nesne sanılmasın: arama öğe
  // listesinden, o yoksa içerik öğesinin bittiği yerden başlar.
  const sonra = xml.indexOf('<elements', icerikSonu)
  const liste = sonra >= 0 ? sonra : xml.indexOf('<elements')
  const ogeler = xml.slice(liste >= 0 ? liste : icerikSonu)
  let bitis = 0

  for (const [, ad, nitelikler = ''] of ogeler.matchAll(/<(\w+)\b([^>]*)/g)) {
    const ofset = /\bstartOffset\s*=\s*["'](\d+)["']/.exec(nitelikler)

    if (!ofset) {
      continue
    }

    const k = Number(ofset[1])
    const uzunluk = /\blength\s*=\s*["'](\d+)["']/.exec(nitelikler)

    bitis = Math.max(bitis, k + Number(uzunluk?.[1] ?? 1))

    if ((ad === 'image' || ad === 'barcode' || ad === 'space') && metin[k] === '¸') {
      konumlar.push(k)
    }
  }

  if (kesik) {
    for (let k = bitis; k < metin.length; k++) {
      if (metin[k] === '¸') {
        konumlar.push(k)
      }
    }
  }

  if (!konumlar.length) {
    return metin
  }

  konumlar.sort((a, b) => a - b)

  let cikti = ''
  let bas = 0

  for (const k of konumlar) {
    if (k < bas) continue
    cikti += metin.slice(bas, k)
    bas = k + 1
  }

  return cikti + metin.slice(bas)
}

/** Dava dökümünde yazılan en derin düzey. */
const DAVA_DERINLIK = 64

/** XML ağacında bir öğe; çocukları metin (CDATA ya da çözülmüş düz metin) ve öğeler, belge sırasıyla. */
type XmlOgesi = { ad: string; nitelikler: [string, string][]; cocuklar: (XmlOgesi | string)[] }

/** Açılış etiketi: tırnaklı nitelik değerindeki `>` etiketi bitirmez, ad her harfi (ş, İ) taşır. */
const ACILIS = /<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y
const NITELIK = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * Küçük, yığınlı bir XML okuyucusu: yorum, işlem talimatı ve DOCTYPE atlanır;
 * CDATA olduğu gibi, düz metin varlıkları çözülerek metin olur. Kök öğeyi
 * döndürür; etiketler eşleşmiyorsa ya da belge yarımsa null.
 */
function xmlAgaci(xml: string): XmlOgesi | null {
  const belge: XmlOgesi = { ad: '', nitelikler: [], cocuklar: [] }
  const yigin = [belge]
  let i = 0

  while (i < xml.length) {
    const ust = yigin[yigin.length - 1] ?? belge
    let son: number

    if (xml[i] !== '<') {
      son = xml.indexOf('<', i)
      son = son < 0 ? xml.length : son
      ust.cocuklar.push(varliklariCoz(xml.slice(i, son)))
      i = son
    } else if (xml.startsWith('<![CDATA[', i)) {
      son = xml.indexOf(']]>', i + 9)
      if (son < 0) return null
      ust.cocuklar.push(xml.slice(i + 9, son))
      i = son + 3
    } else if (xml.startsWith('<!--', i)) {
      son = xml.indexOf('-->', i + 4)
      if (son < 0) return null
      i = son + 3
    } else if (xml.startsWith('<?', i)) {
      son = xml.indexOf('?>', i + 2)
      if (son < 0) return null
      i = son + 2
    } else if (xml.startsWith('<!', i)) {
      // DOCTYPE ya da başka bir bildirim: tırnak dışındaki ilk `>`'de biter;
      // iç altküme (`[...]`) içindeki `>` ve tırnaklı `]` onu bitirmez.
      son = bildirimSonu(xml, i)
      if (son < 0) return null
      i = son + 1
    } else if (xml.startsWith('</', i)) {
      son = xml.indexOf('>', i + 2)
      if (son < 0 || yigin.length < 2 || xml.slice(i + 2, son).trim() !== ust.ad) return null
      yigin.pop()
      i = son + 1
    } else {
      ACILIS.lastIndex = i
      const etiket = ACILIS.exec(xml)
      if (!etiket) return null
      const oge: XmlOgesi = {
        ad: etiket[1] ?? '',
        nitelikler: [...(etiket[2] ?? '').matchAll(NITELIK)].map(
          // XML 1.0 §3.3.3: nitelikteki çıplak sekme ve satır sonu boşluk sayılır.
          (n): [string, string] => [n[1] ?? '', varliklariCoz((n[2] ?? n[3] ?? '').replace(/[\t\n\r]/g, ' '))],
        ),
        cocuklar: [],
      }
      ust.cocuklar.push(oge)
      if (etiket[3] !== '/') yigin.push(oge)
      i = ACILIS.lastIndex
    }
  }

  // Belge tek bir kök öğedir; ondan önce ya da sonra yalnız boşluk olabilir.
  const kokler = belge.cocuklar.filter((c): c is XmlOgesi => typeof c !== 'string')
  const fazlasi = belge.cocuklar.some(c => typeof c === 'string' && c.trim() !== '')

  return yigin.length === 1 && kokler.length === 1 && !fazlasi ? (kokler[0] ?? null) : null
}

/**
 * `<!` ile başlayan bildirimin bittiği `>`'nin yeri; yoksa -1. Tırnaklı
 * literallerin ve iç altkümenin (`[...]`) içindeki `>` ile `]` sayılmaz.
 * Tek geçiştir: belgenin geri kalanını her bildirim için yeniden taramaz.
 */
function bildirimSonu(xml: string, i: number): number {
  let tirnak = ''
  let altKume = false

  for (let k = i + 2; k < xml.length; k++) {
    const c = xml[k]

    if (tirnak) {
      if (c === tirnak) tirnak = ''
    } else if (c === '"' || c === "'") {
      tirnak = c
    } else if (c === '[') {
      altKume = true
    } else if (c === ']') {
      altKume = false
    } else if (c === '>' && !altKume) {
      return k
    }
  }

  return -1
}

/**
 * UYAP'ın dava bilgisi dökümü `.udf` uzantısıyla da kaydedilebiliyor: zip değil,
 * kökü `<dava>` olan düz XML; metin CDATA'da değil, öğelerin içinde. Ağaç
 * girintiyle yazılır: dolu öğe `ad: değer`, nitelikleri ayraç içinde; içi boş
 * dallar atlanır. Girinti, aynı adlı alanın (ör. iki tarafın `ad`'ı) hangi
 * bölüme ait olduğunu gösterir. null: kök `<dava>` değil.
 */
function davaMetni(xml: string): string | null {
  const kok = xmlAgaci(xml)

  if (kok?.ad !== 'dava') {
    return null
  }

  const satirlar: string[] = []

  const yaz = (oge: XmlOgesi, girinti: string) => {
    // Gerçek dökümler yedi düzey; derinlik tavanı yığını ve girintiyle
    // karesel büyüyen çıktıyı uydurma bir belgeye karşı sınırlar.
    if (girinti.length > 2 * DAVA_DERINLIK) {
      throw new Error(`UYAP dava dökümü ${DAVA_DERINLIK} düzeyden derin`)
    }

    const deger = oge.cocuklar
      .filter((c): c is string => typeof c === 'string')
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    const nitelik = oge.nitelikler
      .filter(([, v]) => v.trim() !== '')
      .map(([a, v]) => `${a}=${v.trim()}`)
      .join(', ')
    const once = satirlar.length

    satirlar.push(`${girinti}${oge.ad}${nitelik ? ` (${nitelik})` : ''}${deger ? `: ${deger}` : ''}`)

    for (const cocuk of oge.cocuklar) {
      if (typeof cocuk !== 'string') {
        yaz(cocuk, `${girinti}  `)
      }
    }

    // Kendisi de altı da boş olan öğe yazılmaz.
    if (!deger && !nitelik && satirlar.length === once + 1) {
      satirlar.pop()
    }
  }

  yaz(kok, '')

  return satirlar.join('\n')
}

/** Zip olmayan bir `.udf`'nin gerçekte ne olduğunu ilk baytlarından söyler. */
async function asilTuru($: EngineInterface, yol: string): Promise<string> {
  // Olayın sonucu `string | FsBytes`: araya giren bir hook bayt yerine metin
  // döndürebilir; o zaman tür söylenmez, ret yine olur.
  const ham: unknown = await $.fs.read(yol, { as: 'bytes' }).catch(() => undefined)
  const base64 =
    typeof ham === 'object' && ham !== null && 'base64' in ham ? (ham as { base64: unknown }).base64 : undefined

  if (typeof base64 !== 'string') {
    return ''
  }

  let bas: string

  try {
    bas = atob(base64.slice(0, 16))
  } catch {
    return ''
  }

  if (bas.startsWith('\x89PNG')) return 'dosya aslında bir PNG görseli'
  if (bas.startsWith('\xff\xd8\xff')) return 'dosya aslında bir JPEG görseli'
  if (bas.startsWith('Rar!')) return 'dosya aslında bir RAR arşivi'
  if (bas.startsWith('%PDF')) return 'dosya aslında bir PDF'

  return ''
}

/** Sıkıştırılmadan, düz XML olarak kaydedilmiş bir `.udf`'nin metni. */
async function duzXml($: EngineInterface, yol: string): Promise<string | undefined> {
  const duz = await $.fs.read(yol).catch(() => undefined)

  return typeof duz === 'string' && duz.trimStart().startsWith('<') ? duz : undefined
}

/** `~` açılır, göreli yol oturum dizinine bağlanır: argv'ye hep mutlak yol gider. */
async function mutlakYol($: EngineInterface, ham: string): Promise<string> {
  let yol = ham

  if (yol === '~' || yol.startsWith('~/') || yol.startsWith('~\\')) {
    const ev = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))

    if (!ev) {
      throw new Error('~ açılamadı: HOME tanımlı değil')
    }

    yol = ev.replace(/[\\/]+$/, '') + yol.slice(1)
  }

  // Windows'ta (oturum dizini sürücü harfli) Git Bash yazımı `/c/Users/...`:
  // çekirdek Read bunu `C:\Users\...` diye açar, $.fs ise oturumun sürücüsüne
  // bağlayıp `C:\c\Users\...` yapardı. İzin, zincir ve arşiv aynı dosyaya insin.
  if (/^\/[A-Za-z]\//.test(yol) && /^[A-Za-z]:/.test(await $.session.cwd().catch(() => ''))) {
    return `${yol.charAt(1).toUpperCase()}:${yol.slice(2).replace(/\//g, '\\')}`
  }

  if (yol.startsWith('/') || yol.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(yol)) {
    return yol
  }

  const cwd = await $.session.cwd()

  return `${cwd.replace(/[\\/]+$/, '')}/${yol.replace(/^\.[\\/]/, '')}`
}

/**
 * Arşivden content.xml'i çıkarır. Modül ortamında DecompressionStream yok, bu
 * yüzden açma işi alt sürece verilir: `unzip -p` tek üyeyi stdout'a yazar,
 * unzip başlatılamazsa aynı işi bsdtar (macOS, Windows) yapar. argv vektörü
 * kabuğa uğramadığı için dosya adındaki boşluk ya da Türkçe karakter sorun
 * çıkarmaz.
 */
async function contentXml(
  $: EngineInterface,
  yol: string,
): Promise<{ xml: string; kesik: boolean }> {
  // unzip arşiv adını joker kalıp sayar: `dava[12].udf` yoksa `dava1.udf`'yi
  // sessizce açar. Dosya varsa önce birebir adı dener, o yüzden varlık önce
  // denetlenir. exists yalnız ağ konumunda reddeder; o karar unzip'e kalır.
  const varMi = await $.fs.exists(yol).catch(() => undefined)

  if (varMi === false) {
    throw new Error('dosya bulunamadı')
  }

  if (varMi) {
    const durum = await $.fs.stat(yol).catch(() => undefined)

    if (durum && durum.kind !== 'file') {
      throw new Error('bir dosya değil')
    }
  }

  let cikti

  // Şifreli bir üyede unzip de bsdtar da parolayı oturumun terminalinden
  // (/dev/tty) okur; alt süreç o terminali miras alır, istem arayüzün üstüne
  // yazılır ve süre dolana kadar klavye beklenir. Sabit bir parola istemi
  // kapatır: unzip boş parolayı dener ve 82 ile çıkar, bsdtar "-" ile reddeder.
  try {
    cikti = await $.process.run(['unzip', '-P', '', '-p', yol, 'content.xml'], {
      timeoutMs: ACMA_SURESI,
    })
  } catch (hata) {
    if (/still running/i.test(mesaj(hata))) {
      throw new Error(`arşiv ${ACMA_SURESI / 1000} saniyede açılamadı`)
    }

    // unzip yok. macOS ve Windows'un bsdtar'ı zip okur; Linux'un GNU tar'ı okumaz.
    const tar = await $.process
      .run(['tar', '--passphrase', '-', '-xOf', yol, 'content.xml'], { timeoutMs: ACMA_SURESI })
      .catch(() => undefined)

    if (tar && tar.exitCode === 0) {
      return { xml: tar.stdout, kesik: tar.isStdoutTruncated }
    }

    // Yalnız libarchive'in şifreye özgü iletisi. --passphrase'i tanımayan bir tar
    // (GNU tar, BusyBox, eski bsdtar) da iletisinde seçeneğin adını yazar; onu
    // şifre saymak düz XML'i ve unzip'in yokluğunu gizlerdi.
    if (tar && /Incorrect passphrase|Passphrase required/i.test(tar.stderr)) {
      throw new Error(SIFRELI)
    }

    const duz = await duzXml($, yol)

    if (duz !== undefined) {
      return { xml: duz, kesik: false }
    }

    // bsdtar çalıştı ama açamadı: sebep ortam değil, dosya.
    if (tar && /Not found in archive/i.test(tar.stderr)) {
      throw new Error('arşivde content.xml yok')
    }

    const tur = tar ? await asilTuru($, yol) : ''

    if (tur) {
      throw new Error(`geçerli bir zip arşivi değil (${tur})`)
    }

    throw new Error(
      `unzip çalıştırılamadı (${mesaj(hata)}); sistemde unzip ya da zip okuyabilen bir tar (bsdtar) bulunmalı`,
    )
  }

  // 1 uyarıdır (ör. arşivin başında fazladan bayt); üye yine de çıkar.
  if (cikti.exitCode === 0 || (cikti.exitCode === 1 && cikti.stdout !== '')) {
    return { xml: cikti.stdout, kesik: cikti.isStdoutTruncated }
  }

  if (cikti.exitCode === 11) {
    throw new Error('arşivde content.xml yok')
  }

  if (cikti.exitCode === 82) {
    throw new Error(SIFRELI)
  }

  if (cikti.exitCode === 9) {
    // unzip -p burada stdout'a da stderr'e de bir şey yazmaz.
    const duz = await duzXml($, yol)

    if (duz !== undefined) {
      return { xml: duz, kesik: false }
    }

    const tur = await asilTuru($, yol)

    throw new Error(
      `geçerli bir zip arşivi değil (${tur || 'UDF bozuk ya da başka bir biçimde kaydedilmiş'})`,
    )
  }

  throw new Error(cikti.stderr.trim().split('\n')[0] || `unzip ${cikti.exitCode} ile çıktı`)
}

/** Zip'i açıp düz metni çıkarır: satır sonları LF'ye indirgenmiş, yer tutucular silinmiş. */
async function udfMetni($: EngineInterface, yol: string): Promise<string> {
  const { xml: ham, kesik } = await contentXml($, yol)
  // XML 1.0 §2.11: ayrıştırıcı CRLF ve tek CR'yi, CDATA içinde de, LF'ye çevirir.
  // UDF'nin eleman ofsetleri de bu indirgenmiş metne göredir.
  const xml = ham.replace(/\r\n?/g, '\n')
  const icerik = icerikMetni(xml)

  if (icerik?.kapandi) {
    return yerTutuculariSil(icerik.metin, xml, icerik.bitis, kesik)
  }

  if (kesik) {
    throw new Error('content.xml 4 MiB sınırını aşıyor ve metin sınırın ötesine taşıyor')
  }

  if (icerik) {
    throw new Error('content.xml bozuk: <content> öğesi kapanmıyor')
  }

  const dava = davaMetni(xml)

  if (dava === '') {
    throw new Error('UYAP dava dökümünde dolu bir alan yok')
  }

  if (dava !== null) {
    return dava
  }

  // <content> öğesi olmayan, şablon dışı yazılmış belgeler: ilk CDATA metindir.
  // indexOf ile: tembel bir ifade kapanmayan her `<![CDATA[` için sona kadar tarardı.
  const cdata = xml.indexOf('<![CDATA[')
  const cdataSonu = cdata < 0 ? -1 : xml.indexOf(']]>', cdata + 9)

  if (cdataSonu >= 0) {
    return xml.slice(cdata + 9, cdataSonu)
  }

  throw new Error('content.xml içinde metin bulunamadı')
}

/** Satırlara böler; varlık olarak yazılmış (`&#13;`) bir CR de satır sonu sayılır. */
const satirla = (metin: string) => (metin === '' ? [] : metin.split(/\r\n?|\n/))

/**
 * Panelde çizilecek satır: sekmeler 8'lik duraklara açılır (terminal genişliği
 * sekmeyi 0 sayar, satır çerçeveden taşar), denetim karakterleri atılır (ESC
 * dizisi terminale komut olarak gider), boş satır tek boşlukla yer tutar.
 */
function ekranSatiri(satir: string): string {
  let cikti = ''

  for (const harf of satir.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')) {
    cikti += harf === '\t' ? ' '.repeat(8 - (cikti.length % 8)) : harf
  }

  return cikti === '' ? ' ' : cikti
}

/**
 * Tek satır bir çizimin sınırını aşmasın diye uzun satır parçalanır; kesim bir
 * vekil çiftinin (emoji gibi BMP dışı bir karakterin) ortasına düşmez.
 */
function parcala(satir: string): string[] {
  const parcalar: string[] = []
  let bas = 0

  while (satir.length - bas > PARCA) {
    const kod = satir.charCodeAt(bas + PARCA - 1)
    const son = bas + PARCA - (kod >= 0xd800 && kod <= 0xdbff ? 1 : 0)

    parcalar.push(satir.slice(bas, son))
    bas = son
  }

  parcalar.push(satir.slice(bas))

  return parcalar
}

/** Satırları motorun çizim sınırının altında kalan bölümlere ayırır. */
function bolumle(satirlar: string[]): number[] {
  const baslar = [0]
  let karakter = 0
  let adet = 0

  satirlar.forEach((satir, i) => {
    if (adet > 0 && (karakter + satir.length > BOLUM_KARAKTER || adet >= BOLUM_SATIR)) {
      baslar.push(i)
      karakter = 0
      adet = 0
    }

    karakter += satir.length
    adet += 1
  })

  return baslar
}

/** Read şemasının semanticNumber'ı gibi: "10" gibi bir metni sayıya çevirir. */
const sayiyaCevir = (n: unknown): unknown => {
  if (typeof n !== 'string') return n
  const t = n.trim()
  return /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : n
}

/** Read şemasının kuralı: yok, ya da en az `enAz` olan bir tamsayı. */
function satirSayisi(ad: string, ham: unknown, enAz: number): { n?: number; hata?: string } {
  const n = sayiyaCevir(ham)

  if (n === undefined) {
    return {}
  }

  if (typeof n === 'number' && Number.isInteger(n) && n >= enAz) {
    return { n }
  }

  return { hata: `${ad} en az ${enAz} olan bir tamsayı olmalı (verilen: ${JSON.stringify(ham)}).` }
}

/**
 * Yolun bütün bağları çözülmüş gerçek hâli; çözülemiyorsa undefined. İzin
 * zincirinden önce ve sonra karşılaştırılır.
 */
async function gercekYol($: EngineInterface, yol: string): Promise<string | undefined> {
  const durum = await $.fs.stat(yol, { resolve: true }).catch(() => undefined)

  return durum?.realPath
}

/** Bağlamın doluluğu; okunamazsa ya da henüz bir yanıt yoksa undefined. */
async function baglam($: EngineInterface): Promise<Baglam | undefined> {
  try {
    const { context } = await $.session.usage()

    return context.tokens === undefined
      ? undefined
      : { window: context.window, tokens: context.tokens }
  } catch {
    return undefined
  }
}

/**
 * Bir okumada döndürülecek en fazla karakter. `allow_large` bütünü ister; o
 * zaman da bağlamın boş kalan yarısıyla sınırlanır, model kendini boğmasın.
 * Aynı yanıttaki okumaların hepsi aynı `tokens`'ı görür ve eşzamanlı da
 * çalışabilir; o yarıyı defterden düşerek paylaşırlar, yeni bir yanıt defteri
 * sıfırlar. Hiçbir okuma normal bir sayfadan az almaz.
 */
function okumaSiniri(durum: Baglam | undefined, defter: Defter): number {
  if (!durum) {
    return SAYFA
  }

  if (defter.tokens !== durum.tokens) {
    defter.tokens = durum.tokens
    defter.harcanan = 0
  }

  const pay = Math.floor((durum.window - durum.tokens) * 0.5 * KARAKTER_TOKEN) - defter.harcanan

  return Math.max(SAYFA, pay)
}

/**
 * /udf argümanı: `@` öneki, tırnak ve terminale sürüklemenin ters bölü
 * kaçışları. Windows'ta ve sürücü harfli ya da UNC (`\\sunucu\...`) bir yolda
 * ters bölü ayraçtır; başka yerde kaçış yalnız kabuğun özel karakterlerinden
 * önce çözülür, bu yüzden `belgeler\a.udf` gibi bir yol da bozulmaz.
 */
function argYolu(args: string, windows: boolean): string {
  const ham = args.trim().replace(/^@/, '')
  const tirnakli = /^(['"])([\s\S]*)\1$/.exec(ham)

  if (tirnakli) {
    return tirnakli[2] ?? ''
  }

  if (windows || /^[A-Za-z]:[\\/]/.test(ham) || ham.startsWith('\\\\')) {
    return ham
  }

  return ham.replace(/\\([\s'"()[\]{}&;|<>$`*?!#~=%^,\\])/g, '$1')
}

export const register: Register = on => {
  // Açık belge ve okuma defteri bu yüklemenin kendi belleğinde durur; her
  // yükleme temiz başlar.
  let acikBelge: AcikBelge | undefined
  const defter: Defter = { tokens: -1, harcanan: 0 }

  // Read bir .udf okuduğunda araç metni değil zip'in ham baytlarını görür. Hook,
  // motorun izin zincirini yürüttükten sonra zip'ten çıkan düz metni Read'in
  // kendi çıktı şemasıyla döndürür. Eşleyici kayıtta: başka bir dosyanın
  // okunması bu hook'a hiç uğramaz.
  on('tool.call', { tool: 'Read', file_path: /\.udf$/i }, async ($, e, next) => {
    const ad = kisaAd(e.file_path)

    // Hook şema doğrulamasından önce çalışır: Read'in kendi kuralı burada uygulanır.
    const offset = satirSayisi('offset', e.offset, 0)
    const limit = satirSayisi('limit', e.limit, 1)
    const girdiHatasi = offset.hata ?? limit.hata

    if (girdiHatasi !== undefined) {
      return { deny: `InputValidationError: ${girdiHatasi}` }
    }

    // İzin kuralları mutlak yola göre yazılır; sorgu da okuma da aynı yolu kullanır.
    const yol = await mutlakYol($, e.file_path)

    if (cekirdekYonlendirmesi(yol)) {
      return { deny: `${$.plugin.name}: ${ad} çekirdeğin yönlendirdiği bir yazımla verildi; gerçek yolu doğrulanamadığından metin verilmedi.` }
    }

    // Kural reddi kesin: araç hiç çalışmadan.
    const karar = await $.tool.check({ tool: 'Read', input: { file_path: yol } })

    if (karar.decision === 'deny') {
      return { deny: karar.reason ?? `${ad} için okuma izni yok.` }
    }

    const once = await gercekYol($, yol)

    // İzin diyaloğu, kullanıcının PreToolUse hook'ları ve auto modun
    // sınıflandırıcısı motorun zincirinde, next'in içinde çalışır; check onları
    // sormaz. Zincir aynı dosyanın tek satırlık okumasıyla yürütülür, çıktısı
    // atılır. Modelin pages ve allow_large alanları zincire gitmez: Read girdiyi
    // izinden önce denetler, geçersiz bir değer izin hiç sorulmadan hata verirdi.
    const { pages: _pages, allow_large: _buyuk, ...yalin } = e
    const zincir = await next({ ...yalin, file_path: yol, offset: 1, limit: 1 })

    // Read bir .udf'yi (uzantısı ikili listesinde yok) hatasız, ham bayt olarak
    // okur. Zincirden gelen her ret ve hata (diyalogda ret, hook ya da
    // sınıflandırıcı reddi, dosyanın yokluğu) olduğu gibi döner. Hata metnine
    // bakılmaz: onu kullanıcı da bir hook da yazabilir.
    if (zincir.deny !== undefined || zincir.isError) {
      return zincir
    }

    // İzin yalnız zincirin okuduğu dosya için alındı. Bir PreToolUse hook'u
    // (updatedInput) ya da alttaki bir hook okumayı başka bir dosyaya çevirdiyse
    // sonuç o dosyanın yolunu taşır; özgün dosya açılmaz.
    const okuma = zincir.result as OkunanDosya | undefined
    const ayniDosya =
      (okuma?.type === 'text' || okuma?.type === 'file_unchanged') && okuma.file.filePath === yol

    if (!ayniDosya) {
      return { deny: `${$.plugin.name}: bir hook okumayı başka bir dosyaya yönlendirdi; ${ad} metni verilmedi.` }
    }

    // Zincir izni bu yolun çözüldüğü dosya için verdi. Bağ arada değiştirildiyse
    // izni sorulmamış bir dosya açılmasın; arşiv o gerçek yoldan açılır.
    const sonra = await gercekYol($, yol)

    if (once !== sonra) {
      return { deny: `${$.plugin.name}: ${ad} okuma sırasında başka bir dosyaya döndü; metin verilmedi.` }
    }

    let metin: string

    try {
      metin = await udfMetni($, sonra ?? yol)
    } catch (hata) {
      // Gerçek Read'in sonucu ham zip baytları; sebebi söyleyip duruyoruz.
      return { deny: `${$.plugin.name}: ${ad} açılamadı: ${mesaj(hata)}` }
    }

    const satirlar = satirla(metin)
    // Read şemasının anlamsal boolean'ı gibi: "true" metni de true sayılır.
    const buyuk = e.allow_large === true || (e.allow_large as unknown) === 'true'
    const basla = Math.max(1, offset.n ?? 1) // offset 0, çekirdekteki gibi, baştan demek
    const istenen =
      limit.n === undefined ? satirlar.length : Math.min(satirlar.length, basla - 1 + limit.n)
    // Bağlam ölçüsü ana döngünün; bir alt ajanın penceresi o değil, alt ajan
    // allow_large'da da normal bir sayfa alır.
    const durum = buyuk && e.agentId === undefined ? await baglam($) : undefined

    // Buradan sona kadar await yok: sınırı okuyan ile harcamayı yazan arasına
    // aynı yanıttaki başka bir okuma giremez.
    const sinir = okumaSiniri(durum, defter)

    let son = istenen
    let toplam = 0

    for (let i = basla - 1; i < istenen; i++) {
      toplam += (satirlar[i]?.length ?? 0) + ONEK

      if (toplam > sinir && i > basla - 1) {
        son = i
        break
      }
    }

    const kesildi = son < istenen
    const dilim = satirlar.slice(basla - 1, son)

    if (durum) {
      defter.harcanan += dilim.reduce((t, s) => t + s.length + ONEK, 0)
    }

    const okunan: OkunanDosya = {
      type: 'text',
      file: {
        filePath: e.file_path,
        content: dilim.join('\n'),
        numLines: dilim.length,
        startLine: basla,
        totalLines: satirlar.length,
        ...(kesildi && limit.n === undefined ? { truncatedByTokenCap: true } : {}),
      },
    }

    const notlar = [
      `${ad} bir UDF'den çıkarılmış düz metin; dosyanın kendisi metin değil, Write ya da Edit ile değiştirilemez.`,
    ]

    if (kesildi) {
      const bitis = basla + dilim.length - 1

      notlar.push(
        `${ad} tek okumaya sığmadı: ${basla}-${bitis}. satırlar verildi, dosya ` +
          `${satirlar.length} satır. Devamı için offset: ${bitis + 1} ile oku` +
          (buyuk ? '.' : '; tamamı gerçekten gerekiyorsa allow_large: true.'),
      )
    }

    const cevap: ToolCallResult<'Read'> = { result: okunan, context: notlar }

    return cevap
  }).catch(($, e, next) => ({
    // Beklenmeyen hata ya da süre aşımı: ham zip'e düşülmez.
    deny: `${$.plugin.name}: ${kisaAd(e.file_path)} açılamadı: ${next.error.message ?? 'süre aşıldı'}`,
  }))

  // İkinci kat: motor okunmamış dosyaya yazmayı zaten reddeder, ama düz metin
  // olarak okunan bir UDF'ye bir yazma aracı zip'i (e-imzası dahil) metinle ezer.
  // Motorun yazacağı dosyanın adı .udf ise, yeni dosyada da, yazma reddedilir.
  // Eşleyici adında `.udf` geçen her yolu alır; kararı çözülmüş ad verir.
  on('tool.call', { tool: 'Write', file_path: /\.udf/i }, ($, e, next) =>
    udfeYazar(e.file_path) ? { deny: UDF_YAZILMAZ } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: UDF_YAZILMAZ }))

  on('tool.call', { tool: 'Edit', file_path: /\.udf/i }, ($, e, next) =>
    udfeYazar(e.file_path) ? { deny: UDF_YAZILMAZ } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: UDF_YAZILMAZ }))

  on('tool.call', { tool: 'NotebookEdit', notebook_path: /\.udf/i }, ($, e, next) =>
    udfeYazar(e.notebook_path) ? { deny: UDF_YAZILMAZ } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: UDF_YAZILMAZ }))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'udf',
      description: 'Bir UDF dosyasını metin olarak panelde açar',
      argumentHint: '<dosya yolu>',
    })

    return next(e)
  })

  on('command.run', { command: 'udf' }, async ($, e) => {
    // Windows'ta (oturum dizini sürücü harfli) ters bölü her zaman ayraçtır.
    const cwd = await $.session.cwd().catch(() => '')
    const ham = argYolu(e.args, /^[A-Za-z]:/.test(cwd))

    if (!ham) {
      if (!acikBelge) {
        return { text: 'Kullanım: /udf <dosya.udf yolu>' }
      }

      const acilan = await $.ui.open({ id: PANE, title: `UDF — ${kisaAd(acikBelge.yol)}` })
      const ozet = `${kisaAd(acikBelge.yol)} yeniden açıldı.`

      return { text: acilan.isPlaced ? ozet : `${ozet} Panel şu an çizilemiyor: ${acilan.reason}` }
    }

    if (!udfMu(ham)) {
      return { text: `${kisaAd(ham)} bir .udf dosyası değil.`, exitCode: 1 }
    }

    try {
      const yol = await mutlakYol($, ham)

      if (cekirdekYonlendirmesi(yol)) {
        return { text: `${kisaAd(yol)} çekirdeğin yönlendirdiği bir yazımla açılamaz; dosyanın kendi yolunu verin.`, exitCode: 1 }
      }

      // Read'e yazılmış izin kuralları /udf'ye de uygulanır. Komutu kişi kendisi
      // yazdığında onay sorulmaz; 'ask' gereken bir yol, komut başka bir yerden
      // (bir eklenti, bir kanal, başka bir oturum) geldiyse açılmaz.
      const karar = await $.tool.check({ tool: 'Read', input: { file_path: yol } })

      if (karar.decision === 'deny') {
        return { text: `${kisaAd(yol)} açılamadı: ${karar.reason ?? 'okuma izni yok'}`, exitCode: 1 }
      }

      if (karar.decision === 'ask' && !KISI_KOKENI.has(e.origin.kind)) {
        return {
          text: `${kisaAd(yol)} okumak onay gerektiriyor; /udf komutunu kendiniz yazın.`,
          exitCode: 1,
        }
      }

      const metin = await udfMetni($, yol)
      const mantiksal = satirla(metin)
      const satirlar = mantiksal.map(ekranSatiri).flatMap(parcala)
      const bolumler = bolumle(satirlar)

      acikBelge = { yol, satirlar, bolumler, satir: mantiksal.length }
      await update($, bolum, () => 0)
      await update($, surum, n => n + 1)

      const acilan = await $.ui.open({ id: PANE, title: `UDF — ${kisaAd(yol)}` })
      const bolumNotu = bolumler.length > 1 ? ` Panelde ${bolumler.length} bölüm halinde.` : ''
      const ozet =
        `${kisaAd(yol)} açıldı: ${mantiksal.length} satır, ${metin.length} karakter.${bolumNotu}`

      return { text: acilan.isPlaced ? ozet : `${ozet} Panel şu an çizilemiyor: ${acilan.reason}` }
    } catch (hata) {
      return { text: `${kisaAd(ham)} açılamadı: ${mesaj(hata)}`, exitCode: 1 }
    }
  }).catch(($, e, next) => ({
    text: `/udf başarısız: ${next.error.message ?? 'süre aşıldı'}`,
    exitCode: 1,
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)

    // Sayaç okunur ki yeni bir /udf paneli yeniden çizdirsin; metin modülde.
    await read($, surum)

    const acik = acikBelge

    if (!acik) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Henüz bir UDF açılmadı. /udf &lt;dosya yolu&gt;</Text>
        </Box>
      )
    }

    const toplam = Math.max(1, acik.bolumler.length)
    const k = Math.min(Math.max(0, await read($, bolum)), toplam - 1)
    const bas = acik.bolumler[k] ?? 0
    const son = acik.bolumler[k + 1] ?? acik.satirlar.length

    // Göreli adım: çizim yenilenmeden gelen ikinci basış da bir bölüm daha
    // ilerletir. Kaydırma yapılamazsa (pencere o arada kıpırdadı) bölüm yine
    // değişir; yalnız eski kaydırma konumunda açılır.
    const git = (adim: 1 | -1) => () => {
      void update($, bolum, n => Math.min(Math.max(0, n + adim), toplam - 1)).then(() =>
        $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined),
      )
    }

    // Kaydırma motorun: bölümün tamamı çizilir, pencereyi motor scroll.offset'e
    // göre kaydırır. Ağaç bodyRows'a kırpılırsa sığar ve hiç kaydırılamaz.
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {kisaAd(acik.yol)} · {acik.satir} satır
          {toplam > 1 ? ` · bölüm ${k + 1}/${toplam}` : ''}
        </Text>
        {acik.satirlar.slice(bas, son).map(satir => (
          <Text wrap="wrap">{satir}</Text>
        ))}
        {toplam > 1 ? (
          <Box flexDirection="row" gap={1}>
            {k > 0 ? <Button key="onceki" label="◀ Önceki bölüm" onPress={git(-1)} /> : null}
            {k < toplam - 1 ? (
              <Button key="sonraki" label="Sonraki bölüm ▶" onPress={git(1)} />
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}
