# X Tweet Temizle

Kendi X (Twitter) hesabındaki **gönderileri, yanıtları ve alıntıları siler; repost'ları geri alır.**

- **Arşiv indirmen gerekmez.** X'ten veri indirme talebi açıp 1-2 gün beklemene gerek yok.
- **Sunucu yok, hesap bilgisi yok.** Şifre, token veya API anahtarı istemez. Tarayıcındaki açık oturumu kullanır.
- **Hiçbir veri dışarı gitmez.** Üçüncü bir servise bağlanmaz. Tek trafik, senin tarayıcının X'e yaptığı normal isteklerdir.
- **Ücretsiz ve açık kaynak.** Kodun tamamı tek dosyada: [`temizle.js`](temizle.js).

---

## Kurulum

1. Yeşil **Code** düğmesi → **Download ZIP** → ZIP'i bir klasöre çıkar.
2. Chrome (veya Edge) aç, adres çubuğuna yaz: `chrome://extensions`
3. Sağ üstten **Geliştirici modu**'nu aç.
4. **Paketlenmemiş öğe yükle** → adım 1'de çıkardığın klasörü seç.

Listede "X Tweet Temizle" göründüyse kurulum bitti.

## Kullanım

1. `https://x.com` adresine git ve kendi hesabınla giriş yapmış ol.
2. Kendi profiline git: `https://x.com/KULLANICI_ADIN/with_replies`
3. Sağ üstte çıkan **X Tweet Temizle** kutusunda **Başlat**'a bas.
4. Onay ekranında **hesap adının doğru olduğunu** kontrol et → **Tamam**.
5. Sekmeyi açık bırak. Kutuda ilerleme akar; istediğin an **Durdur**'a basabilirsin.

Tek başlatma yeter: önce yanıtlar sekmesini, sonra repost sekmesini kendisi gezip temizler.

## Çalışırken bilgisayarı kullanabilir miyim?

Evet, ama x.com sekmesi **kendi penceresinde aktif sekme** kalmalı.

- Başka uygulamaya veya **başka bir Chrome penceresine** geçebilirsin — sorun olmaz.
- Aynı penceredeki **başka bir sekmeye** geçersen Chrome arka plan zamanlayıcılarını kısar, işlem çok yavaşlar.
- Sekmeyi kapatırsan/yenilersen durur. O ana kadar silinenler geri gelmez; yeniden başlatırsan kalanlardan devam eder.

## Süre

Gönderi başına 1,5–2,5 saniye, her 40 işlemde 30 saniye mola (X'in hız sınırına takılmamak için).
Kabaca **250 gönderi ≈ 15–20 dakika**.

## Güvenlik davranışı

- **Yalnızca kendi profilinde** çalışır; başka bir sayfada başlamayı reddeder.
- **Sadece senin gönderilerine ve kendi repost'larına** dokunur. Başkasının gönderisi listede olsa bile atlanır.
- Her adımda açık hesap yeniden doğrulanır; hesap değişirse **durur**.
- **Düğmeye basmak başarı sayılmaz**: her gönderi için gerçekten kaybolduğu doğrulanır. Doğrulanamayan "atlandı" sayılır.
- Menü veya onay düğmesi kesin tanınamazsa **durur**, tahmin yürütmez.
- Üst üste 5 başarısız işlemde durur (X arayüzü değişmiş olabilir).

## Sınırlar

- **Silme geri alınamaz.** Onay ekranındaki hesap adını mutlaka kontrol et.
- X arayüz dili **Türkçe veya İngilizce** olmalı (silme menüsü bu iki dilde tanınır).
- X, zaman akışında bir seferde sınırlı sayıda eski gönderi yükler. Bittiğinde sayfayı yenileyip tekrar çalıştırırsan kalanlara iner.
- Güncel X arayüzüyle kesintisiz çalışma garanti edilmez; X tasarımını değiştirirse araç yanlış bir şeye tıklamaz, işlemi keser.
- Chrome veya Edge gerekir.

---

## Yapay zekâ asistanına vereceğin metin

Bu aracı bir AI asistanıyla (Claude, ChatGPT vb.) kullanacaksan aşağıdaki metni olduğu gibi ver:

```
Görev: X (Twitter) hesabımdaki tüm gönderileri, yanıtları ve alıntıları sil, repost'larımı geri al.

Araç: https://github.com/barbaros-technologies/x-tweet-temizle
Bu bir Chrome eklentisidir. Sunucu, API anahtarı veya şifre gerektirmez;
tarayıcıdaki açık X oturumu üzerinden arayüzü kullanarak çalışır.

Adımlar:
1. Depoyu indir, ZIP'i çıkar.
2. chrome://extensions aç, "Geliştirici modu"nu aç,
   "Paketlenmemiş öğe yükle" ile klasörü yükle.
3. https://x.com/<KULLANICI_ADI>/with_replies adresini aç.
4. Sayfanın sağ üstündeki panelde "Başlat" düğmesine bas.
5. Çıkan onay penceresinde hesap adını doğrula ve onayla.
6. Sekmeyi açık ve aktif bırak; panelde ilerlemeyi izle.

Önemli:
- Silme geri alınamaz; onay ekranındaki hesap adı doğru olmalı.
- Sekme kendi penceresinde aktif kalmalı, yoksa tarayıcı işlemi yavaşlatır.
- Araç yalnızca kullanıcının kendi gönderilerine dokunur; şüpheli
  durumda yanlış işlem yapmak yerine durur.
- Tek başlatma yeter: yanıtlar ve repost sekmelerini kendisi gezer.
```

---

MIT lisansı. X/Twitter ile bağlantılı resmî bir ürün değildir.
