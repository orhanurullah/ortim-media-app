# Ortim Media Manager (OMM) — Kullanım Kılavuzu

Ortim Media Manager (OMM), video ve ses içeriklerini bilgisayarınıza
indirmenizi, kütüphanenizi yönetmenizi, indirdiğiniz medyayı düzenlemenizi
**ve kayıtlarınızı tamamen çevrimdışı yapay zekâ ile yazıya dökmenizi**
sağlayan **Windows için yerel bir masaüstü uygulamasıdır**.

> **Yerel ve gizli:** Uygulama hiçbir uzak sunucu kullanmaz; indirme,
> düzenleme ve **transkripsiyon dahil her şey sizin bilgisayarınızda** olup
> biter. Ses/videolarınız yazıya dökülürken de hiçbir yere yüklenmez.
> Tarayıcı eklentisi de yalnızca kendi bilgisayarınızdaki uygulamayla konuşur.

---

## İçindekiler

1. [Sistem gereksinimleri](#1-sistem-gereksinimleri)
2. [Kurulum — masaüstü uygulaması](#2-kurulum--masaüstü-uygulaması)
3. [Tarayıcı eklentisini yükleme](#3-tarayıcı-eklentisini-yükleme)
4. [İlk kullanım — bir video indirme](#4-ilk-kullanım--bir-video-indirme)
5. [Transkripsiyon — sesi/videoyu yazıya dökme](#5-transkripsiyon--sesivideoyu-yazıya-dökme)
6. [Kütüphane ve düzenleme paneli](#6-kütüphane-ve-düzenleme-paneli)
7. [Sorun giderme](#7-sorun-giderme)
8. [Yasal uyarı](#8-yasal-uyarı)

---

## 1. Sistem gereksinimleri

- **Windows 10 veya Windows 11** (64-bit)
- Yaklaşık **500 MB boş disk alanı** (uygulama + paketli araçlar için;
  transkripsiyon modeli ilk kullanımda ayrıca indirilir)
- İndirilen videolar için ek disk alanı (kullanıma göre değişir)
- **Microsoft Edge WebView2 Runtime**
  - Windows 10/11'de zaten kurulu gelir.
  - Eksikse Microsoft'tan indirilebilir:
    <https://developer.microsoft.com/microsoft-edge/webview2/>

---

## 2. Kurulum — masaüstü uygulaması

### Adım 1 — Kurulum dosyasını indirin

En güncel sürümü indirin:

**<https://github.com/orhanurullah/ortim-media-app/releases/latest>**

Sayfadaki **`OrtimMediaManager-Setup.exe`** dosyasını indirin.

### Adım 2 — Windows SmartScreen uyarısı

İlk çalıştırmada Windows muhtemelen şu mesajı gösterecek:

> **Windows bilgisayarınızı korudu**
> Microsoft Defender SmartScreen, tanınmayan bir uygulamanın
> başlamasını engelledi.

Bu uyarı **uygulamanın henüz dijital imzalı olmamasından** kaynaklanır,
bir virüs tehdidi değildir. Devam etmek için:

1. Mavi yazıdaki **"Daha fazla bilgi"** bağlantısına tıklayın.
2. Açılan **"Yine de çalıştır"** düğmesine basın.

Bu uyarıyı yalnızca **ilk kurulumda** görürsünüz.

### Adım 3 — Kurulum

Kurucu **yönetici izni istemez**; uygulamayı yalnızca sizin kullanıcı
hesabınıza kurar ve Başlat menüsüne **"Ortim Media Manager"** kısayolu
ekler. Kurulum birkaç saniye sürer.

Uygulama ayarlarını ve kütüphane veritabanını
`%LocalAppData%\OMMDesktop` klasöründe tutar.

### Adım 4 — İndirme klasörünü seçin

Uygulama açıldığında **Ayarlar** sekmesinden indirilen dosyaların
nereye kaydedileceğini seçebilirsiniz. Varsayılan olarak
`C:\Users\<sizin_adınız>\Downloads\OMM\` kullanılır.

---

## 3. Tarayıcı eklentisini yükleme

Tarayıcı eklentisi, açtığınız sayfalardaki video ve ses akışlarını
otomatik olarak tespit eder ve tek tıkla masaüstü uygulamasına gönderir.

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

1. **Ortim Media Manager'ı açın** (eklenti masaüstü uygulamasıyla konuşur).
2. Tarayıcının sağ üstündeki uzantılar menüsünden uygulamanın simgesine
   tıklayın (görünmüyorsa puzzle parça simgesi → uzantı → "raptiye"
   simgesiyle sabitleyin).
3. Açılan popup'ın üst başlığında **"bağlı 39343"** yazmalı (yeşil).
   - "kopuk" yazıyorsa: masaüstü uygulaması kapalı ya da 39343 portu başka
     bir uygulama tarafından kullanılıyor.

---

## 4. İlk kullanım — bir video indirme

### Yöntem A — tarayıcı eklentisi ile (önerilen)

1. Ortim Media Manager açık olsun.
2. Herhangi bir video sayfası açın (YouTube, Vimeo, Twitter, haber
   siteleri vb.).
3. Sayfa yüklendikten sonra eklenti popup'ını açın — bulunan akışlar
   listelenmiş olacak.
4. İstediğiniz akışın yanındaki **"Kuyruğa"** veya **"İndir"** düğmesine
   tıklayın.
5. Uygulamadaki **Kuyruk** sekmesinde indirme görünür ve başlar.

### Yöntem B — URL yapıştırma

1. Uygulamada üst kısımdaki adres çubuğuna video URL'sini yapıştırın.
2. **"Analiz Et"** düğmesine basın.
3. Format ve kalite seçin (önayar veya manuel).
4. **"İndir"** butonuna basın.

### İndirme tamamlandığında

Dosya **Kütüphane** sekmesinde otomatik olarak görünür. Üzerine
tıklayarak oynatabilir, açıklamalarını görebilir veya düzenleyebilirsiniz.

---

## 5. Transkripsiyon — sesi/videoyu yazıya dökme

Ortim Media Manager, ses ve video kayıtlarınızı **tamamen çevrimdışı**,
cihaz üstünde çalışan **Whisper** yapay zekâsıyla aranabilir metne
dönüştürür. Hiçbir ses dosyası buluta yüklenmez.

### Model indirme

1. **Transkriptler** ekranını açın.
2. Bir model indirin. Uygulama makinenize göre bir model **önerir** —
   çoğu bilgisayar için **Base** iyi bir denge sunar (küçük **Tiny**
   modeli hızlıdır ama belirgin biçimde daha az doğrudur).

### Tek bir dosyayı yazıya dökme

1. Kütüphane'de bir ses/video dosyası seçin.
2. **Araçlar** sekmesinden **Transkribe et**'e basın.
3. İşlem cihazınızda çalışır; tamamlanınca metin görüntülenir.

### Birden çok dosyayı aynı anda (toplu)

1. Kütüphane'de **iki veya daha fazla** ses/video dosyası seçin
   (eklemek için Ctrl+tık, aralık için Shift+tık ya da "Tümünü seç").
2. Listenin üstünde beliren toplu işlem çubuğundan **"Transkribe et"**e
   tıklayın.
3. Her dosya kuyruğa eklenir ve **tek tek** işlenir; toplu iş aynı anda
   birden çok model çalıştırıp belleğinizi tüketmez.

### Sonuçla ne yapabilirsiniz

- **Tam metin arama** ve sonuçtaki ana atlama.
- Satır satır **düzenleme**.
- **SRT, VTT veya TXT** olarak dışa aktarma; ayrıca **Word (.docx)** rapor.

> Transkripsiyon, **Studio** özelliğidir.

---

## 6. Kütüphane ve düzenleme paneli

**Kütüphane** sekmesi indirdiğiniz tüm dosyaları gösterir. Bir öğeyi
seçip **Araçlar** menüsünden şu işlemleri yapabilirsiniz:

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
| **Transkribe et** | Sesi/videoyu çevrimdışı yazıya dök (Studio) |

Her düzenleme işlemi **yeni bir dosya** oluşturur — orijinaliniz korunur.

---

## 7. Sorun giderme

### Eklenti popup'ında "kopuk" yazıyor

- Ortim Media Manager açık mı? Açık değilse açın.
- Açıkken hâlâ "kopuk" diyorsa: 39343 portunu başka bir uygulama
  tutuyor olabilir. Uygulamayı yeniden başlatın.

### "Windows bilgisayarınızı korudu" uyarısı

İmzasız `.exe` çalıştırırken normaldir. **"Daha fazla bilgi" → "Yine
de çalıştır"** ile geçebilirsiniz. Bkz. [Adım 2](#adım-2--windows-smartscreen-uyarısı).

### Eklenti video bulamıyor

- Bazı siteler videoları özel oynatıcılarla (DRM, custom MSE buffer)
  yükler ve dışarıdan görünmez. Bu durumda video sayfasının URL'sini
  doğrudan uygulamaya yapıştırın.

### İndirme yarıda kaldı / yavaş

- Kuyruktaki işin üzerine tıklayıp **Yeniden dene** seçin.
- Ağ bağlantınızı kontrol edin.
- VPN kullanıyorsanız geçici olarak kapatıp deneyin.

### Transkripsiyon sonucu boş / anlamsız çıkıyor

- **Base** modelini kullandığınızdan emin olun. En küçük **Tiny** modeli
  hızlıdır ama özellikle müzik/gürültü içeren kayıtlarda zayıf sonuç
  verebilir; Ayarlar'dan daha büyük bir model seçin.

### "WebView2 bulunamadı" hatası

Microsoft'tan WebView2 Runtime kurun:
<https://developer.microsoft.com/microsoft-edge/webview2/>

### Uygulamayı sıfırlamak

Ayarlar/veritabanını sıfırlamak isterseniz uygulamayı kapatıp
`%LocalAppData%\OMMDesktop` klasörünü silin, sonra tekrar açın —
uygulama sıfırdan kurulmuş gibi başlar. (İndirdiğiniz medya dosyaları
bu klasörde değildir, silinmez.)

### Antivirüs / SmartScreen uyarıları

Uygulama dijital olarak imzalı olmadığı için bazı antivirüsler
"bilinmiyor" işaretleyebilir. **Bu bir virüs uyarısı değildir** —
sadece uygulamanın imzasız olduğu anlamına gelir. İçinde paketli
`yt-dlp.exe` ve `ffmpeg.exe` araçları açık kaynaklıdır:

- yt-dlp: <https://github.com/yt-dlp/yt-dlp>
- FFmpeg: <https://ffmpeg.org/>

---

## 8. Yasal uyarı

Ortim Media Manager **yalnızca** sahibi olduğunuz, yönettiğiniz veya
yasal olarak indirme/işleme hakkına sahip olduğunuz içerikler için
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
