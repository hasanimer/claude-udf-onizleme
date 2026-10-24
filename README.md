# UDF Önizleme

UYAP doküman formatındaki (UDF) dosyaları Claude Code içinde okunur kılan bir eklenti.

UDF, içinde `content.xml` taşıyan bir zip arşividir; dilekçe ya da kararın metni o dosyada
durur. Claude Code'un `Read` aracı bir `.udf` dosyasını metin sanıp zip'in sıkıştırılmış
baytlarını döndürür: model anlamsız karakterler görür, dosya önizlemesi de "ikili veri" der.
Bu eklenti arşivi yerelde açar, metni çıkarır ve iki yerde sunar: modelin `Read` aracında ve
transkriptin yanındaki bir panelde. Avukatların UYAP'tan indirdiği dilekçe, karar ve
tutanaklarla Claude Code'da doğrudan çalışabilmesi için yazıldı.

## Ne yapar

**`Read` bir `.udf` okuduğunda düz metin döner.** Model dosyayı doğrudan okuyabilir;
transkriptteki araç sonucu da metni gösterir. `offset`, `limit` ve `allow_large` gerçek
`Read`'deki gibi çalışır. Uzun belgeler tek okumada bağlamı doldurmasın diye sayfalanır ve
modele devamını nereden okuyacağı söylenir. `allow_large` bir okumayı bağlamın boş kalan
yarısıyla sınırlar, ama hiçbir okuma normal bir sayfadan (60.000 karakter) az almaz; aynı
yanıttaki büyük okumalar o yarıyı paylaşır. Alt ajanlarda `allow_large` normal sayfayla
sınırlıdır. Model her okumada, bunun UDF'den çıkarılmış metin olduğunu ve dosyanın `Write` ya
da `Edit` ile değiştirilemeyeceğini söyleyen kısa bir not da alır.

**`/udf <dosya yolu>` belgeyi kendi panelinde açar.** Panel kaydırılabilir. Claude Code bir
çizimde en çok 100.000 karakter gösterebildiği için uzun belgeler bölümlere ayrılır ve
bölümler arasında düğmeyle geçilir. `~`, göreli yol, tırnaklı yol, terminale sürüklenen
(ters bölülü) yol ve Windows yolları (sürücü harfi, UNC, Git Bash'in `/c/...` yazımı) kabul
edilir.

**`.udf` dosyalarını yazma araçlarına karşı korur.** `Write`, `Edit` ya da `NotebookEdit`
bir `.udf` dosyasına, dosya var olsun olmasın, yazmaya kalkarsa reddedilir. Karar, Claude
Code'un yolu nasıl çözeceğine göre verilir: `dilekce.udf ` ya da `dilekce.udf/.` gibi aynı
dosyaya inen yazımlar da reddedilir. Aksi hâlde model metni gördükten sonra dosyayı düz
metinle ezebilir, zip arşivi de çoğu zaman içindeki e-imza paketiyle birlikte geri dönüşsüz
bozulurdu. Yeni bir UDF için UDF üreten bir araç kullanılmalı. Koruma dosya adına bakar;
`Bash` ile yazmayı kapsamaz.

Çıkarılan metin UDF'nin kendi kurallarına göre temizlenir: satır sonları birleştirilir,
bölünmüş CDATA blokları birleşir, XML varlıkları çözülür ve UDF'nin her gömülü görsel ya da
barkod için metne koyduğu `¸` yer tutucusu silinir.

## Kurulum

Kabuktan:

```bash
claude plugin marketplace add hasanimer/claude-udf-onizleme
claude plugin install udf-onizleme@hasanimer
```

Ya da bir terminal oturumunun komut satırından:

```
/plugin marketplace add hasanimer/claude-udf-onizleme
/plugin install udf-onizleme@hasanimer
```

Masaüstü uygulamasında: komut kutusunun yanındaki **+** → **Plugins** → **Add marketplace**
(`hasanimer/claude-udf-onizleme`) → **Add plugin**.

## Gereksinimler

- Claude Code'un mod destekleyen bir sürümü (terminalde 2.1.287, masaüstünde 2.1.286 ve sonrası).
- Arşivi açmak için `unzip` (macOS ve çoğu Linux'ta kuruludur). `unzip` yoksa zip okuyabilen
  bir `tar` (macOS ve Windows'taki bsdtar) kullanılır; Linux'un GNU tar'ı zip okumaz.

## Kullanım

Claude'dan bir UDF'yi okumasını isteyin ya da yolunu verin; `Read` metni getirir. Kendiniz
görmek için:

```
/udf ~/Belgeler/dilekce.udf
```

Argümansız `/udf` son açılan belgenin panelini yeniden açar.

## İzinler

Eklenti Claude Code'un izin sistemini atlamaz. Model bir `.udf` okumak istediğinde:

1. `Read` için yazılmış izin kuralları sorulur; reddedilen yol hiç açılmaz.
2. Motorun izin zinciri, aynı dosyanın tek satırlık bir `Read`'iyle yürütülür: izin
   diyaloğu, sizin `PreToolUse` hook'larınız ve auto modun sınıflandırıcısı. Diyalogda ve
   hook'larda bu yüzden `offset: 1, limit: 1` görünür. Zincirden gelen her ret ve her hata,
   metni ne olursa olsun, olduğu gibi modele döner; metin ancak zincir hatasız geçerse
   çıkarılır.
3. Bir hook okumayı başka bir dosyaya yönlendirdiyse (`updatedInput`), izin o dosya için
   alınmıştır; özgün dosyanın metni verilmez. Yol bir sembolik bağsa, bağın izinden önce ve
   sonra aynı dosyaya çıktığı denetlenir ve arşiv o gerçek yoldan açılır. Claude Code'un
   dosya arayüzü ağ konumlarında gerçek yolu çözmediği için bu denetim orada yapılamaz;
   macOS çekirdeğinin yönlendirdiği `/.vol`, `/.file`, `/.nofollow` ve `/.resolve`
   yazımları ise hiç açılmaz.

`/udf` de `Read` kurallarını sorar ve reddedilen yolu açmaz. Komutu siz yazdığınızda izin
diyaloğu açılmaz, `PreToolUse` hook'ları sorulmaz; onay gerektiren bir yol, komut sizden
değil de bir eklentiden ya da başka bir oturumdan geldiyse açılmaz.

Yani `permissions.deny` ile korunan bir klasördeki UDF, eklenti kurulu olsa da okunamaz.

## Ne çalıştırır, ne gönderir, ne saklar

- **Çalıştırdığı:** yalnız `.udf` dosyaları için, yerelde `unzip -P '' -p <dosya> content.xml`
  (yoksa `tar --passphrase - -xOf`). Komut kabuktan geçmez; dosya adı argüman olarak verilir.
  Sabit parola, şifreli bir arşivde terminalden parola istenmesini önler.
- **Okuduğu:** dosyanın var olup olmadığına, türüne ve bağlarının çözüldüğü gerçek yola
  Claude Code'un dosya arayüzüyle bakar; göreli bir yolu oturum dizinine bağlar. Zip olmayan
  bir `.udf`'yi (düz XML olarak kaydedilmiş belge) ya da türünü söylemek için dosyanın
  kendisini (en çok 4 MiB) okur. `allow_large` istendiğinde okuma sınırı için oturumun bağlam
  doluluğuna bakar. Ortam değişkeni olarak yalnız `~` ile başlayan bir yolu açmak için `HOME`
  (Windows'ta `USERPROFILE`).
- **Gönderdiği:** hiçbir şey. Eklenti ağa çıkmaz, telemetri toplamaz, başka bir servise veri
  aktarmaz. Metin yalnız sizin oturumunuzdaki modele, `Read`'in kendi sonucu olarak gider ve
  her araç sonucu gibi Claude Code'un oturum kaydına girer.
- **Sakladığı:** `/udf` ile açılan son belgenin metni panel için eklentinin kendi
  belleğinde durur. Oturumun paylaşılan durumuna (her eklentinin okuyabildiği yer) yalnız
  bir sayaç ile açık bölümün sırası yazılır; belgenin metni ve yolu yazılmaz. Eklenti diske
  dosya yazmaz.

Araç çağrısı hook'ları kayıtlarında yollara bağlıdır: `Read` hook'u adı `.udf` ile biten
yollara, yazma hook'ları adında `.udf` geçen yollara. Başka bir araç çağrısı bu hook'lara hiç
uğramaz; `.udf` dosyasına inmeyen bir yazma da dokunulmadan geçer.

## Sınırlar

- **Dosya önizleme panelini değiştirmez.** Bir `.udf` dosyasına tıklandığında açılan yerleşik
  görüntüleyici Claude Code'un kendi alanıdır, eklentilere kapalıdır; orada "ikili veri" uyarısı
  sürer. `/udf` bunun yerine eklentinin kendi panelini açar.
- **Yalnız metin aktarılır.** Sayfa düzeni (kenar boşlukları, yazı tipi, punto, hizalama,
  kalın/italik) panele taşınmaz; panel bir sayfa değil, metin akışıdır.
- E-imza paketi (`sign.sgn`) okunmaz ve imza doğrulanmaz. Parolayla şifrelenmiş bir arşiv
  açılmaz; sebebi söylenir.
- Zip olmayan `.udf` dosyaları da tanınır: sıkıştırılmadan düz XML olarak kaydedilmiş
  belgeler okunur; UYAP'ın `<dava>` kökü taşıyan dosya bilgisi dökümleri girintili bir alan
  ağacı olarak okunur. Aslında PNG, JPEG, RAR ya da PDF olan bir dosya, ne olduğu
  söylenerek reddedilir.

## Geliştirme

```bash
claude --plugin-dir . --debug
claude plugin validate . --strict
claude plugin test .
npx -y -p typescript@5.9.3 tsc -p .
```

Tip denetimi, Claude Code'un eklentiyi ilk yüklediğinde `.claude-plugin/types/` altına yazdığı
tipleri kullanır; bu yüzden önce eklenti bir kez `--plugin-dir` ile yüklenmeli. TypeScript 5.9
gerekir; 5.6, bu tiplerde derinlik sınırına takılır.

Testler 84 senaryoyu kapsar: okuma ve sayfalama, bozuk, şifreli ya da alışılmadık UDF
biçimleri, `unzip` olmayan sistemler, izin zinciri (metninde "binary file" geçen retler,
`updatedInput` yönlendirmesi, bağ değişimi ve çekirdek yönlendirme yazımları dahil), yazma
koruması, ayrıştırmanın doğrusal kalması, `/udf` yol çözümü ve panelin çizim sınırları. Claude Code 2.1.289 ve 2.1.308'in test kitleriyle geçer.

## Lisans

MIT — bkz. [LICENSE](LICENSE).
