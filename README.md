# Ortim Medya App — Kullanım Kılavuzu

Ortim Medya App (ODM), video ve ses içeriklerini bilgisayarınıza
indirmenizi, kütüphanenizi yönetmenizi ve indirdiğiniz medyayı
düzenlemenizi sağlayan **Windows için yerel bir masaüstü uygulamasıdır**.

> **Yerel ve gizli:** Uygulama hiçbir uzak sunucu kullanmaz; her şey
> sizin bilgisayarınızda olup biter. Tarayıcı eklentisi de yalnızca
> kendi bilgisayarınızdaki uygulamayla konuşur.

---

## İçindekiler

1. [Sistem gereksinimleri](#1-sistem-gereksinimleri)
2. [Kurulum — masaüstü uygulaması](#2-kurulum--masaüstü-uygulaması)
3. [Tarayıcı eklentisini yükleme](#3-tarayıcı-eklentisini-yükleme)
4. [İlk kullanım — bir video indirme](#4-ilk-kullanım--bir-video-indirme)
5. [Kütüphane ve düzenleme paneli](#5-kütüphane-ve-düzenleme-paneli)
6. [Sorun giderme](#6-sorun-giderme)
7. [Yasal uyarı](#7-yasal-uyarı)

---

## 1. Sistem gereksinimleri

- **Windows 10 veya Windows 11** (64-bit)
- Yaklaşık **400 MB boş disk alanı** (uygulama + paketli araçlar için)
- İndirilen videolar için ek disk alanı (kullanıma göre değişir)
- **Microsoft Edge WebView2 Runtime**
  - Windows 10/11'de zaten kurulu gelir.
  - Eksikse Microsoft'tan indirilebilir:
    <https://developer.microsoft.com/microsoft-edge/webview2/>

Uygulama **kurulum gerektirmez** — tek bir taşınabilir `.exe` dosyasıdır.

---

## 2. Kurulum — masaüstü uygulaması

### Adım 1 — `.exe` dosyasını çift tıklayın

`ODM-Desktop-Portable-1.0.0.exe` dosyasına çift tıklayın.

### Adım 2 — Windows SmartScreen uyarısı

İlk açılışta Windows muhtemelen şu mesajı gösterecek:

> **Windows bilgisayarınızı korudu**
> Microsoft Defender SmartScreen, tanınmayan bir uygulamanın
> başlamasını engelledi.

Bu uyarı **uygulamanın imzalı olmamasından** kaynaklanır, virüs
tehdidi değildir. Devam etmek için:

1. Mavi yazıdaki **"Daha fazla bilgi"** bağlantısına tıklayın.
2. Açılan **"Yine de çalıştır"** düğmesine basın.

Bu uyarıyı yalnızca **ilk açılışta** görürsünüz.

### Adım 3 — Otomatik açılma

Uygulama ilk açılışta:

- Kendini `%LOCALAPPDATA%\OrtimDM\Portable\1.0.0\` klasörüne açar
  (yaklaşık 360 MB).
- Pencereyi başlatır.

Bu işlem **20–30 saniye** sürebilir. Sonraki açılışlar anında olur.

### Adım 4 — İndirme klasörünü seçin

Uygulama açıldığında **Ayarlar** sekmesinden indirilen dosyaların
nereye kaydedileceğini seçebilirsiniz. Varsayılan olarak
`C:\Users\<sizin_adınız>\Downloads\ODM\` kullanılır.

---

## 3. Tarayıcı eklentisini yükleme

Tarayıcı eklentisi, açtığınız sayfalardaki video ve ses akışlarını
otomatik olarak tespit eder ve tek tıkla ODM Desktop'a gönderir.

### Chrome için

1. Tarayıcıda `chrome://extensions/` adresini açın.
2. Sağ üstteki **"Geliştirici modu"** anahtarını **açık** konuma getirin.
3. Sol üstteki **"Paketlenmemiş öğe yükle"** düğmesine basın.
4. Açılan pencerede **`browser-extension/chrome-extension`** klasörünü
   seçin.

### Edge için

1. Tarayıcıda `edge://extensions/` adresini açın.
2. Sol kenardaki **"Geliştirici modu"** anahtarını **açık** konuma getirin.
3. **"Paketlenmemiş öğeleri yükle"** düğmesine basın.
4. Açılan pencerede **`browser-extension/edge-extension`** klasörünü
   seçin.

### Bağlantıyı doğrulama

1. **ODM Desktop'ı açın** (eklenti masaüstü uygulamasıyla konuşur).
2. Tarayıcının sağ üstündeki uzantılar simgesinden **ODM** simgesine
   tıklayın (görünmüyorsa puzzle parça simgesi → ODM → "raptiye"
   simgesiyle sabitleyin).
3. Açılan popup'ın üst başlığında **"bağlı 39343"** yazmalı (yeşil).
   - "kopuk" yazıyorsa: ODM Desktop kapalı veya 39343 portu başka bir
     uygulama tarafından kullanılıyor.

---

## 4. İlk kullanım — bir video indirme

### Yöntem A — tarayıcı eklentisi ile (önerilen)

1. ODM Desktop açık olsun.
2. Herhangi bir video sayfası açın (YouTube, Vimeo, Twitter, haber
   siteleri vb.).
3. Sayfa yüklendikten sonra ODM eklenti popup'ını açın — bulunan
   akışlar listelenmiş olacak.
4. İstediğiniz akışın yanındaki **"Kuyruğa"** veya **"İndir"** düğmesine
   tıklayın.
5. ODM Desktop'taki **Kuyruk** sekmesinde indirme görünür ve başlar.

### Yöntem B — URL yapıştırma

1. ODM Desktop'ta üst kısımdaki adres çubuğuna video URL'sini
   yapıştırın.
2. **"Analiz Et"** düğmesine basın.
3. Format ve kalite seçin (önayar veya manuel).
4. **"İndir"** butonuna basın.

### İndirme tamamlandığında

Dosya **Kütüphane** sekmesinde otomatik olarak görünür. Üzerine
tıklayarak oynatabilir, açıklamalarını görebilir veya düzenleyebilirsiniz.

---

## 5. Kütüphane ve düzenleme paneli

**Kütüphane** sekmesi indirdiğiniz tüm dosyaları gösterir. Bir öğeye
sağ tıklayarak veya seçip **Düzenle** menüsünden şu işlemleri
yapabilirsiniz:

| İşlem | Açıklama |
|---|---|
| **Dönüştür** | Format değiştir (mp4 ↔ mkv, mp3 vb.) |
| **Kes** | Belirli bir aralığı kesip yeni dosya oluştur |
| **Birleştir** | İki dosyayı arka arkaya yapıştır |
| **Filigran ekle** | Görüntüye yazı / logo bindir |
| **Görsel iyileştir** | Çözünürlük artır + netleştir |
| **Hız değiştir** | Yavaşlat veya hızlandır (ses tonu korunur) |
| **Çevir** | Yatay / dikey ayna |
| **Ton/renk** | Parlaklık, kontrast, doygunluk, ton |
| **Ses normalleştir** | Ses seviyesini standartlaştır (EBU R128) |
| **Altyazı göm** | `.srt` dosyasını videoya kalıcı işle |
| **Kırp** | Ekrandan istediğiniz dikdörtgeni al |
| **Döndür** | 90° / 180° / 270° |
| **Sıkıştır** | Dosya boyutunu küçült (CRF presetler) |
| **GIF dışa aktar** | Belirli bir aralığı GIF olarak kaydet |

Her işlem **yeni bir dosya** oluşturur — orijinaliniz korunur.

---

## 6. Sorun giderme

### Eklenti popup'ında "kopuk" yazıyor

- ODM Desktop açık mı? Açık değilse açın.
- ODM Desktop açıkken hâlâ "kopuk" diyorsa: 39343 portunu başka bir
  uygulama tutuyor olabilir. ODM Desktop'ı yeniden başlatın.

### "Windows bilgisayarınızı korudu" uyarısı

İmzasız `.exe` çalıştırırken normaldir. **"Daha fazla bilgi" → "Yine
de çalıştır"** ile geçebilirsiniz. Bkz. [Adım 2](#adım-2--windows-smartscreen-uyarısı).

### Eklenti video bulamıyor

- Bazı siteler videoları özel oynatıcılarla (DRM, custom MSE buffer)
  yükler ve dışarıdan görünmez. Bu durumda video sayfasının URL'sini
  doğrudan ODM Desktop'a yapıştırın.

### İndirme yarıda kaldı / yavaş

- Kuyruktaki işin üzerine tıklayıp **Yeniden dene** seçin.
- Ağ bağlantınızı kontrol edin.
- VPN kullanıyorsanız geçici olarak kapatıp deneyin.

### "WebView2 bulunamadı" hatası

Microsoft'tan WebView2 Runtime kurun:
<https://developer.microsoft.com/microsoft-edge/webview2/>

### Uygulama açılmıyor

- `%LOCALAPPDATA%\OrtimDM\Portable\1.0.0\` klasörünü silin ve portable
  `.exe`'yi tekrar çalıştırın — sıfırdan açar.

### Antivirüs / SmartScreen uyarıları

Uygulama dijital olarak imzalı olmadığı için bazı antivirüsler
"bilinmiyor" işaretleyebilir. **Bu bir virüs uyarısı değildir** —
sadece uygulamanın imzasız olduğu anlamına gelir. İçinde paketli
`yt-dlp.exe` ve `ffmpeg.exe` araçları açık kaynaklıdır:

- yt-dlp: <https://github.com/yt-dlp/yt-dlp>
- FFmpeg: <https://ffmpeg.org/>

---

## 7. Yasal uyarı

ODM Desktop **yalnızca** sahibi olduğunuz, yönettiğiniz veya yasal
olarak indirme/işleme hakkına sahip olduğunuz içerikler için
kullanılmalıdır.

- Pek çok platform (YouTube, Vimeo vb.) hizmet şartlarında otomatik
  indirmeyi kısıtlar — bu şartlara uymak **kullanıcının
  sorumluluğundadır**.
- Telif hakkı korumalı içerikleri izinsiz indirmek, dağıtmak veya
  yeniden yayınlamak **yasalara aykırıdır**.
- Uygulama "olduğu gibi" sunulur; herhangi bir amaç için uygunluk
  garantisi verilmez.

Bu uygulamayı kişisel ve adil kullanım amacıyla, yasalara uygun
şekilde kullandığınızdan emin olun.

---

## Yardım ve geri bildirim

Sorun veya öneri için: orhann.1512@gmail.com
