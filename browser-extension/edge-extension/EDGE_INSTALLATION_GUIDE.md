# 🌐 ODM Stream Detector - Microsoft Edge Installation Guide

## 📋 **Microsoft Edge için ODM Extension Kurulum Rehberi**

### 🎯 **Genel Bakış**

ODM Stream Detector for Edge, Microsoft Edge tarayıcısı için özel olarak optimize edilmiş bir browser extension'dır. Chromium tabanlı Edge'in güçlü özelliklerinden yararlanarak en iyi performansı sunar.

### ✨ **Edge'e Özel Özellikler**

#### **🔒 Enhanced Security**
- Edge'in gelişmiş güvenlik özelliklerinden yararlanma
- SmartScreen ve Defender entegrasyonu
- Tracking Prevention ile uyumlu çalışma

#### **🎨 Windows 11 Native Design**
- Windows 11 Fluent Design System ile uyumlu
- Native scrollbar ve UI elements
- System theme desteği

#### **⚡ Performance Optimizations**
- Edge WebView2 teknolojisi desteği
- Chromium engine optimizasyonları
- Düşük bellek kullanımı

#### **📚 Edge Collections Integration**
- Edge Collections ile uyumlu (gelecek güncellemede)
- Koleksiyonlara stream ekleme özelliği
- Organize indirme yönetimi

### 🚀 **Kurulum Adımları**

#### **Yöntem 1: Developer Mode (Önerilen)**

1. **Microsoft Edge'i Açın**
   ```
   Microsoft Edge tarayıcısını başlatın
   ```

2. **Extension Sayfasına Git**
   ```
   edge://extensions/ adresine gidin
   ```

3. **Developer Mode Aktif Et**
   - Sol alttaki "Developer mode" toggle'ını aktif edin
   - Sayfa yenilenecek ve yeni butonlar görünecek

4. **Extension Yükle**
   - "Load unpacked" butonuna tıklayın
   - `browser-extension/edge-extension` klasörünü seçin
   - "Select Folder" butonuna tıklayın

5. **Extension Aktifleştir**
   - Extension listesinde "ODM Stream Detector for Edge" görünecek
   - Toggle'ı "On" konumuna getirin
   - Pin butonuna tıklayarak toolbar'a sabitleyin

#### **Yöntem 2: Microsoft Edge Add-ons Store (Gelecekte)**

Microsoft Edge Add-ons Store'da yayınlandığında:

1. **Edge Add-ons Store'a Git**
   ```
   https://microsoftedge.microsoft.com/addons/
   ```

2. **ODM Stream Detector Ara**
   ```
   Arama çubuğuna "ODM Stream Detector" yazın
   ```

3. **Install Butonuna Tıkla**
   ```
   Extension sayfasında "Get" butonuna tıklayın
   ```

### ⚙️ **Kurulum Sonrası Ayarlar**

#### **1. ODM Uygulamasını Başlat**
```bash
# ODM uygulamasını çalıştırın
mvn javafx:run

# veya
java -jar ODM.jar
```

#### **2. WebSocket Bağlantısını Kontrol Et**
- Extension popup'ını açın
- Bağlantı durumunu kontrol edin
- "ODM'e Bağlı ✅" mesajını görmelisiniz

#### **3. Test İndirme**
- Herhangi bir video sitesine gidin (örn: YouTube)
- Extension popup'ını açın
- "Stream'leri Tara" butonuna tıklayın
- Tespit edilen stream'lerden birini indirin

### 🔧 **Edge-Specific Ayarlar**

#### **Privacy ve Security**
```
edge://settings/privacy
```
- **Tracking prevention**: "Balanced" (Önerilen)
- **Block potentially unwanted apps**: Açık
- **Microsoft Defender SmartScreen**: Açık

#### **Downloads**
```
edge://settings/downloads
```
- **Download location**: ODM klasörünü ayarlayın
- **Ask where to save each file**: Kapalı (ODM yönetsin)

#### **Site Permissions**
```
edge://settings/content
```
- **Downloads**: "Allow" olarak ayarlayın
- **Notifications**: Extension için izin verin

### 🎯 **Edge vs Chrome vs Firefox Karşılaştırması**

| Özellik | Edge | Chrome | Firefox |
|---------|------|--------|---------|
| **Performance** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **Security** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Windows Integration** | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐ |
| **Memory Usage** | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Extension Support** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

### 🔍 **Troubleshooting**

#### **❌ Extension Yüklenmiyor**

**Çözüm 1: Developer Mode Kontrol**
```
1. edge://extensions/ sayfasına gidin
2. "Developer mode" toggle'ının açık olduğunu kontrol edin
3. Sayfayı yenileyin (Ctrl+F5)
```

**Çözüm 2: Klasör Kontrolü**
```
1. edge-extension klasörünün manifest.json içerdiğini kontrol edin
2. Dosya yolunda Türkçe karakter olmadığını kontrol edin
3. Klasörün read-only olmadığını kontrol edin
```

#### **❌ ODM'e Bağlanamıyor**

**Çözüm 1: ODM Uygulaması Kontrolü**
```
1. ODM uygulamasının çalıştığını kontrol edin
2. WebSocket server'ın port 8080'de çalıştığını kontrol edin
3. Windows Firewall'un engellemediğini kontrol edin
```

**Çözüm 2: Edge Security Settings**
```
1. edge://settings/privacy sayfasına gidin
2. "Enhance your security on the web" ayarını "Balanced" yapın
3. Site permissions'da localhost için izin verin
```

#### **❌ Stream Tespit Edilmiyor**

**Çözüm 1: Content Script Kontrolü**
```
1. F12 Developer Tools açın
2. Console sekmesine geçin
3. "Enhanced ODM Stream Detector" mesajını arayın
4. Hata mesajı varsa kontrol edin
```

**Çözüm 2: Site Compatibility**
```
1. Desteklenen site listesini kontrol edin
2. JavaScript'in etkin olduğunu kontrol edin
3. Ad-blocker'ların stream'leri engellemediğini kontrol edin
```

### 📊 **Performance Monitoring**

#### **Edge DevTools Integration**
```
1. F12 tuşuna basın
2. Performance sekmesine geçin
3. Extension'ın CPU/Memory kullanımını izleyin
4. Network sekmesinde WebSocket trafiğini kontrol edin
```

#### **Extension Memory Usage**
```
1. edge://extensions/ sayfasına gidin
2. ODM Extension'ının yanındaki "Details" tıklayın
3. "Inspect views" altında memory usage'ı kontrol edin
```

### 🎉 **Başarılı Kurulum Testi**

Extension başarıyla kurulduğunda:

1. ✅ **Toolbar'da pin ikonunu görebilirsiniz**
2. ✅ **Popup açıldığında "Edge Optimized" yazısını görebilirsiniz**  
3. ✅ **YouTube'da video sayfasında download butonunu görebilirsiniz**
4. ✅ **Extension popup'ında "ODM'e Bağlı ✅" durumunu görebilirsiniz**
5. ✅ **Stream'ler başarıyla tespit edilir ve indirilir**

### 🌟 **Edge Premium Features (Yakında)**

- **🔗 Edge Collections Integration**
- **📱 Mobile Edge Sync**
- **🎯 Smart Download Suggestions**
- **📈 Detailed Analytics**
- **🎨 Fluent Design 2.0**

---

**🎯 ODM for Edge ile modern download experience'i keşfedin!**

Sorularınız için: [support@ortim.dev](mailto:support@ortim.dev)
