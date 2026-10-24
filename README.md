# udf-onizleme

UDF (UYAP doküman formatı) dosyalarını Claude Code içinde metin olarak okunabilir kılan bir
eklenti.

UDF, içinde `content.xml` taşıyan bir zip arşividir; dilekçe metni o dosyada CDATA bloğunda
durur. Claude Code bir `.udf` dosyasını kendi başına ikili veri olarak gördüğü için ne model
okuyabilir ne de ekranda bir şey görünür. Bu eklenti iki yerde araya girer.

## Ne yapar

**`Read` aracı `.udf` okuduğunda düz metin döner.** Eklenti `tool.call` zincirini keser,
arşivi açar ve metni Read'in kendi çıktı şemasıyla verir. Böylece model dosyayı doğrudan
okuyabilir ve transkriptteki araç sonucu satırı da metin gösterir. `offset` ve `limit`
uygulanır.

**`/udf <dosya yolu>` dosyayı kendi panelinde açar.** Panel transkriptin yanında durur,
kaydırılabilir ve dört yüzeyde de (terminal, masaüstü, VS Code, mobil) çizilir.

Açma başarısız olursa eklenti sessizce gerçek `Read`'e düşmez — ham zip baytlarını okutmak
yerine sebebi söyleyip durur.

## Kurulum

Kabuktan, iki adım — önce marketplace eklenir, sonra eklenti `ad@marketplace` ile kurulur:

```bash
claude plugin marketplace add hasanimer/claude-udf-onizleme
claude plugin install udf-onizleme@hasanimer
```

Bir terminal oturumunun komut satırından aynı iki adım:

```
/plugin marketplace add hasanimer/claude-udf-onizleme
/plugin install udf-onizleme@hasanimer
```

Masaüstü uygulamasında `/plugin` çalışmaz: komut kutusunun yanındaki **+** → **Plugins** →
**Add marketplace** (`hasanimer/claude-udf-onizleme`) → **Add plugin**.

> `claude plugin install … --marketplace …` biçimi bu sürümde yoktur; `install` komutu
> `--marketplace` seçeneğini tanımaz, marketplace adı `@` ile verilir.

## Gereksinim

Arşivi açmak için sistemde `unzip` bulunmalıdır (macOS ve çoğu Linux dağıtımında kuruludur).
Eklenti modülü Node ve `DecompressionStream` olmadan çalıştığından açma işini
`$.process.run(['unzip', '-p', …])` ile alt sürece verir; argv vektörü kullanıldığı için
dosya adındaki boşluk ve Türkçe karakter sorun çıkarmaz, kabuk araya girmez.

## Sınırlar

- **Dosya önizleme panelini değiştirmez.** Bir `.udf` dosyasına tıklandığında açılan yerleşik
  görüntüleyici motorun kendi alanıdır ve eklentilere kapalıdır; orası "ikili veri" demeye
  devam eder. `/udf` bunun yerine eklentinin kendi panelini açar.
- **Yalnız metin aktarılır.** UDF'nin sayfa biçimi (marjlar, punto, yazı tipi, satır aralığı,
  hizalama, kalın/italik) `content.xml` içinde durur ama panele taşınmaz; panel bir sayfa
  değil, metin akışıdır.
- Arşivdeki `content.xml` dışındaki üyeler (imza paketi `sign.sgn` dahil) okunmaz.

## Geliştirme

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir . --debug
```

## Lisans

MIT
