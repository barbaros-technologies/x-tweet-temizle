// X Tweet Temizle — BarbarOS Technologies LLC.
// Lisans: PolyForm Noncommercial 1.0.0 (bkz. LICENSE.md). Ticari kullanim ve
// urunlestirme YASAKTIR; kisisel ve kar amaci gutmeyen kullanim serbesttir.
// Kendi profilindeki gonderileri ekrandan tek tek siler. Arsiv gerekmez.
// Sunucu yok, ajan yok, ucuncu tarafa veri gitmez. Acik oturum uzerinden calisir.
(function () {
  "use strict";

  // ---- Sabitler -------------------------------------------------------------
  const DELETE_WORDS = new Set(["delete", "sil"]);
  // Repost geri alma onayinin GORUNEN metni. X Turkce arayuzu "Yeniden gonderi"
  // terimini kullanir; canli arayuzde dogrulanan metin "Yeniden gonderiyi geri al".
  // Liste eksik olursa her repost "onay taninamadi" ile durur, hicbiri silinmez.
  const UNDO_WORDS = new Set([
    "undo repost", "undo retweet",
    "yeniden gönderiyi geri al", "yeniden gonderiyi geri al",
    "repostu geri al", "retweeti geri al",
  ]);
  const MIN_DELAY = 1400;      // silmeler arasi en az bekleme
  const MAX_DELAY = 2400;      // silmeler arasi en fazla bekleme
  const PAUSE_EVERY = 40;      // her N silmede bir uzun mola
  const PAUSE_MS = 30000;      // uzun mola suresi
  const SCROLL_TRIES = 3;      // akis buyumeden kac tur sonra sekme bitmis sayilsin
  const SCROLL_WAIT = 2000;    // kaydirma sonrasi X'in yeni kayit getirmesine taninan sure
  const STEP_TIMEOUT = 12000;  // tek bir arayuz adimi icin bekleme tavani

  class StopError extends Error {}

  const normalize = (t) => String(t || "").trim().replace(/\s+/g, " ").toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () => MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));

  // ---- DOM yardimcilari (arsiv surumunden birebir tasindi) -------------------
  function visible(el) {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  }

  function statusLink(href) {
    try {
      const url = new URL(href, "https://x.com");
      if (url.origin !== "https://x.com") return null;
      const m = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,24})\/?$/);
      return m ? { username: m[1].toLowerCase(), id: m[2] } : null;
    } catch (_) { return null; }
  }

  // Acik oturumdaki hesabi iki bagimsiz yerden okuyup celisirse null doner.
  function currentUser() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const m = (link?.getAttribute("href") || "").match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const handles = [...new Set((switcher?.textContent || "").match(/@[A-Za-z0-9_]{1,15}\b/g) || [])];
    const profile = m?.[1].toLowerCase();
    const account = handles.length === 1 ? handles[0].slice(1).toLowerCase() : null;
    if (profile && account && profile !== account) return null;
    return profile || account || null;
  }

  // Bir gonderinin ana yazarini ve kimligini kesin cikarir; supheliyse null.
  function articleIdentity(article) {
    const header = article.querySelector('[data-testid="User-Name"]');
    if (!header || header.closest('article[data-testid="tweet"]') !== article) return null;
    const authors = [...new Set([...header.querySelectorAll("a[href]")].map((a) =>
      (a.getAttribute("href") || "").match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase()
    ).filter(Boolean))];
    if (authors.length !== 1) return null;
    // DIKKAT: alintilanan tweet div[role="link"] icinde durur ve elenmelidir.
    // Ama gonderinin KENDI zaman damgasi a[role="link"] icindedir; genel
    // [role="link"] elemesi mesru zaman damgasini da eleyip kimligi bozar.
    const ids = [...article.querySelectorAll("time")].filter((t) => {
      const own = t.closest('[data-testid="User-Name"]');
      return t.closest('article[data-testid="tweet"]') === article && !t.closest('div[role="link"]') && (!own || own === header);
    }).map((t) => statusLink(t.closest("a[href]")?.getAttribute("href"))).filter((v) => v?.username === authors[0]);
    return ids.length === 1 ? ids[0] : null;
  }

  function controls(article, selector) {
    return [...article.querySelectorAll(selector)]
      .filter((el) => el.closest('article[data-testid="tweet"]') === article && !el.closest('div[role="link"]') && visible(el));
  }

  function single(list, label) {
    if (list.length !== 1) throw new StopError(label + " kesin tanınamadı. İşlem durdu.");
    return list[0];
  }

  // Acik menu / onay penceresi yuzeyleri (ic ice olanlar elenir).
  function surface() {
    const all = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [data-testid="Dropdown"]')].filter(visible);
    return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  }

  // Profil basligindaki toplam gonderi sayisi ("257 gonderi" / "257 posts").
  // Sadece bilgilendirme icindir; islem bu sayiya gore sinirlanmaz.
  function totalPosts() {
    for (const el of document.querySelectorAll('[data-testid="primaryColumn"] div')) {
      if (el.childElementCount) continue;
      const m = normalize(el.textContent).match(/^([\d.,\s]+)\s*(gönderi|gonderi|posts?)$/);
      if (m) return m[1].replace(/[^\d]/g, "");
    }
    return null;
  }

  // ---- Durum ----------------------------------------------------------------
  // skipped: islenemedigi icin bir daha denenmeyecek kimlikler. Bu kume olmadan
  // silinemeyen tek bir gonderi donguyu sonsuza kadar kilitler.
  const state = { running: false, stop: false, done: 0, failed: 0, owner: null, skipped: new Set() };

  function guard() {
    if (state.stop) throw new StopError("Kullanıcı durdurdu.");
    if (location.origin !== "https://x.com") throw new StopError("x.com dışına çıkıldı.");
    if (currentUser() !== state.owner) throw new StopError("Açık hesap değişti veya doğrulanamadı.");
  }

  async function waitFor(read) {
    const until = Date.now() + STEP_TIMEOUT;
    while (Date.now() < until) {
      guard();
      const v = read();
      if (v) return v;
      await sleep(120);
    }
    return null;
  }

  // ---- Aday secimi ----------------------------------------------------------
  // Silinebilir = (a) kendi yazdigim gonderi, veya (b) benim repost'um.
  // diag: eleme adimlarinin sayaci. Aday cikmadiginda nerede elendigini soyler.
  function candidates(diag) {
    const out = [];
    const d = diag || {};
    d.article = d.gorunur = d.kimlik = d.atlanan = d.benim = d.caret = 0;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      d.article++;
      if (!visible(article)) continue;
      d.gorunur++;
      const id = articleIdentity(article);
      if (!id) continue;
      d.kimlik++;
      if (state.skipped.has(id.id)) { d.atlanan++; continue; }
      const isRepost = controls(article, '[data-testid="unretweet"]').length === 1;
      const mine = id.username === state.owner;
      if (!isRepost && !mine) continue;      // baskasinin gonderisi: dokunma
      d.benim++;
      if (controls(article, '[data-testid="caret"]').length !== 1 && !isRepost) continue;
      d.caret++;
      out.push({ article, id: id.id, isRepost });
    }
    return out;
  }

  // ---- Tek gonderi islemi ---------------------------------------------------
  async function handleOne(item) {
    guard();
    if (surface().length) throw new StopError("Beklenmeyen açık menü veya pencere var.");

    if (item.isRepost) {
      const btn = single(controls(item.article, '[data-testid="unretweet"]'), "Repost düğmesi");
      btn.click();
      const confirm = await waitFor(() => {
        const menus = surface();
        if (!menus.length) return null;
        const items = [...menus[0].querySelectorAll('[data-testid="unretweetConfirm"]')].filter(visible);
        return items.length ? items[0] : null;
      });
      if (!confirm || !UNDO_WORDS.has(normalize(confirm.textContent))) throw new StopError("Repost geri alma onayı tanınamadı.");
      confirm.click();
    } else {
      const caret = single(controls(item.article, '[data-testid="caret"]'), "Gönderi menüsü");
      caret.click();
      const del = await waitFor(() => {
        const menus = surface();
        if (!menus.length) return null;
        const items = [...menus[0].querySelectorAll('[role="menuitem"]')]
          .filter((el) => visible(el) && DELETE_WORDS.has(normalize(el.textContent)));
        return items.length === 1 ? items[0] : null;
      });
      if (!del) throw new StopError("Sil menü öğesi tanınamadı. X dili Türkçe veya İngilizce olmalı.");
      del.click();
      const confirm = await waitFor(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
        if (!dialogs.length) return null;
        const btns = [...dialogs[0].querySelectorAll('[data-testid="confirmationSheetConfirm"]')].filter(visible);
        return btns.length ? btns[0] : null;
      });
      if (!confirm || !DELETE_WORDS.has(normalize(confirm.textContent))) throw new StopError("Son silme onayı tanınamadı.");
      confirm.click();
    }

    // Dogrulama: dugmeye basmak basari degildir. Gonderi listeden gercekten
    // kalkmali (veya repost ise geri alinmis gorunmeli).
    const ok = await waitFor(() => {
      if (surface().length) return null;                       // menu hala acikken karar verme
      const still = candidates().some((c) => c.id === item.id && !c.isRepost);
      if (item.isRepost) {
        const row = candidates().find((c) => c.id === item.id);
        return !row || !row.isRepost ? true : null;
      }
      return !still ? true : null;
    });
    if (!ok) throw new StopError("Sonuç doğrulanamadı: " + item.id);
  }

  // ---- Sekme gezinme --------------------------------------------------------
  // X profil sekmeleri UC ayri akistir ve birbirinde gorunmezler:
  //   ""             Gonderiler        -> kendi gonderilerin + alintilarin
  //   "with_replies" Yanitlar          -> YALNIZ yanitlar (eski "gonderiler ve
  //                                       yanitlar" birlesik sekmesi artik yok)
  //   "reposts"      Yeniden gonderiler -> repost'lar
  // 2026-09-13'te canli arayuzde olculdu: Yanitlar sekmesi bosken Gonderiler
  // sekmesinde tweetler duruyordu. Gonderiler sekmesi listede olmazsa kendi
  // tweetlerin HIC silinmez, yalniz RT'ler gider. Tek baslatmada hepsini
  // temizlemek icin uc sekmeyi de kendimiz geziyoruz. X tek sayfa uygulamasi
  // oldugundan sekme baglantisina tiklamak sayfayi yeniden yuklemez.
  const TABS = ["", "with_replies", "reposts"];
  const tabName = (tab) => tab || "gonderiler";

  function currentTab() {
    const p = location.pathname.toLowerCase().replace(/\/$/, "");
    const base = "/" + state.owner;
    return p === base ? "" : p.slice(base.length + 1);
  }

  async function gotoTab(ui, tab) {
    const target = "/" + state.owner + (tab ? "/" + tab : "");
    const link = [...document.querySelectorAll('a[role="tab"]')].find((a) => {
      try { return new URL(a.href, location.origin).pathname.toLowerCase().replace(/\/$/, "") === target; }
      catch (_) { return false; }
    });
    if (!link) { ui.log("Sekme bağlantısı bulunamadı: " + tabName(tab)); return false; }
    link.click();
    const ok = await waitFor(() => currentTab() === tab ? true : null);
    if (!ok) { ui.log("Sekmeye geçilemedi: " + tabName(tab)); return false; }
    await sleep(2500);   // zaman akisinin yuklenmesini bekle
    return true;
  }

  // ---- Ana dongu ------------------------------------------------------------
  // Her sekmeyi sirayla, silinecek gonderi kalmayana kadar temizler.
  async function loop(ui) {
    for (const tab of TABS) {
      if (state.stop) return;
      ui.log("--- sekme: " + tabName(tab) + " ---");
      if (currentTab() !== tab && !(await gotoTab(ui, tab))) continue;
      await clearTab(ui);
    }
  }

  async function clearTab(ui) {
    let emptyScrolls = 0;
    let streak = 0;   // ust uste basarisiz islem sayaci
    let hiddenWarned = false;
    while (!state.stop) {
      guard();
      const diag = {};
      const list = candidates(diag);

      if (!list.length) {
        // Gizli sekmede X yeni gonderi YUKLEMEZ (sonsuz kaydirma
        // IntersectionObserver'a bagli, o da arka planda tetiklenmez).
        // Burada "akisin sonu" demek yanlis teshis olur: 2026-09-13'te 221
        // gonderili profil, sekme arka plana dusunce 3 silmeden sonra "bitti"
        // dedi. Sekme gorunur olana kadar sayaci ilerletmeden bekle.
        if (document.hidden) {
          if (!hiddenWarned) {
            ui.log("Sekme arka planda: X gizli sekmede yeni gönderi yüklemez. Bu sekmeyi öne getir, bekliyorum…");
            hiddenWarned = true;
          }
          await sleep(1500);
          continue;
        }
        if (hiddenWarned) { ui.log("Sekme öne geldi, devam."); hiddenWarned = false; emptyScrolls = 0; }
        // X hala yukluyorsa (donen halka) "akisin sonu" sayma. Taze acilan
        // sekmede ilk sayfa gelmeden 2 tur kaydirip "bitti" demistik (2026-09-13).
        if ([...document.querySelectorAll('[data-testid="primaryColumn"] [role="progressbar"]')].some(visible)) {
          await sleep(1000);
          continue;
        }
        // Korlemesine N kez kaydirmak yerine akisin gercekten bittigini olc:
        // sayfa yuksekligi buyumuyorsa X yeni kayit yuklemiyor demektir.
        const before = document.body.scrollHeight;
        scrollTo(0, before);
        await sleep(SCROLL_WAIT);
        const grew = document.body.scrollHeight > before;
        emptyScrolls = grew ? 0 : emptyScrolls + 1;
        if (emptyScrolls >= SCROLL_TRIES) {
          // Ekranda gonderi VARKEN aday cikmadiysa bu "temiz" degil, "goremedim"
          // demektir. Eleme sayaclarini yaz ki sebebi panelden okunabilsin.
          ui.log("Bu sekmede silinecek kalmadı.");
          if (diag.gorunur) ui.log("Görünen " + diag.gorunur + " gönderi elendi — kimlik:" + diag.kimlik + " benim:" + diag.benim + " menü:" + diag.caret + " atlanan:" + diag.atlanan);
          return;
        }
        ui.log(grew ? "Yeni kayıtlar yükleniyor…" : "Akışın sonu (" + emptyScrolls + "/" + SCROLL_TRIES + ")");
        continue;
      }
      emptyScrolls = 0;

      const item = list[0];
      try {
        await handleOne(item);
        state.done++;
        streak = 0;
        ui.log("Silindi: " + item.id + "  (toplam " + state.done + ")");
      } catch (e) {
        if (e instanceof StopError && (state.stop || currentUser() !== state.owner)) throw e;
        state.failed++;
        streak++;
        state.skipped.add(item.id);   // ayni gonderiye takilip kalmayi onler
        ui.log("Atlandı: " + item.id + " — " + (e.message || e));
        // Acik kalmis menu varsa kapat ki sonraki adim temiz baslasin.
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(600);
        if (streak >= 5) throw new StopError("Üst üste 5 başarısız işlem. X arayüzü değişmiş olabilir; durduruldu.");
      }

      ui.count();
      if (state.done && state.done % PAUSE_EVERY === 0) {
        ui.log("Mola: " + (PAUSE_MS / 1000) + " sn (X limitine takılmamak için)");
        await sleep(PAUSE_MS);
      } else {
        await sleep(jitter());
      }
    }
  }

  // ---- Arayuz ---------------------------------------------------------------
  function buildUI() {
    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
      "width:280px", "padding:12px", "border-radius:12px",
      "background:#15181c", "color:#e7e9ea", "border:1px solid #2f3336",
      "font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif",
      "box-shadow:0 6px 24px rgba(0,0,0,.45)"
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "X Tweet Temizle v1.12";
    title.style.cssText = "font-weight:600;margin-bottom:8px";

    const info = document.createElement("div");
    info.style.cssText = "color:#8b98a5;margin-bottom:10px";
    info.textContent = "Kendi profilinde aç, sonra başlat.";

    const start = document.createElement("button");
    start.textContent = "Başlat";
    start.style.cssText = "width:100%;padding:8px;border:0;border-radius:8px;background:#1d9bf0;color:#fff;font-weight:600;cursor:pointer";

    const stop = document.createElement("button");
    stop.textContent = "Durdur";
    stop.style.cssText = "width:100%;padding:8px;margin-top:6px;border:0;border-radius:8px;background:#3a1417;color:#f4212e;font-weight:600;cursor:pointer;display:none";

    const log = document.createElement("div");
    log.style.cssText = "margin-top:10px;max-height:120px;overflow:auto;color:#8b98a5;font-size:12px";

    box.append(title, info, start, stop, log);
    document.body.appendChild(box);

    const ui = {
      log(msg) {
        const line = document.createElement("div");
        line.textContent = msg;
        log.prepend(line);
        while (log.childElementCount > 40) log.lastElementChild.remove();
        console.log("[x-temizle]", msg);
      },
      count() { info.textContent = "Silinen: " + state.done + " · Atlanan: " + state.failed; },
      busy(on) { start.style.display = on ? "none" : "block"; stop.style.display = on ? "block" : "none"; }
    };

    start.addEventListener("click", () => void begin(ui, false));
    stop.addEventListener("click", () => { state.stop = true; ui.log("Durduruluyor…"); });
    return ui;
  }

  // ---- Baslatma -------------------------------------------------------------
  // Otomatik baslatma: sayfa "#otomatik" etiketiyle acildiysa onay penceresi
  // ACILMAZ; panelde 5 sn geri sayim yazilir ve islem kendiliginden baslar.
  // Tarayiciyi bir ajan surerken (Haydar vb.) tiklama gerektirmemesi icin.
  // Etiketi ekleyen kisi onayi vermis sayilir; geri sayimda Durdur iptal eder.
  // X tek sayfa uygulamasi adresi hemen degistirebildigi icin ILK yuklenen
  // adrese bakilir (navigation entry), sonradan tiklanan sekmelere bulasmaz.
  function autoRequested() {
    const nav = performance.getEntriesByType("navigation")[0];
    const first = (nav && nav.name) || location.href;
    return /#otomatik$/.test(first) || /#otomatik$/.test(location.href);
  }

  async function begin(ui, auto) {
    if (state.running) return;

    const me = currentUser();
    if (!me) { alert("Açık X hesabı doğrulanamadı. Sayfayı yenileyip tekrar dene."); return; }

    // Yalnizca kendi profil sayfanda calis: baskasinin akisinda yanlislikla islem yapma.
    // Kendi profilinin uc sekmesi de izinli; hangisinden baslanirsa baslansin
    // loop() ucunu de gezer (bkz. TABS).
    const path = location.pathname.toLowerCase().replace(/\/$/, "");
    const allowed = ["/" + me, "/" + me + "/with_replies", "/" + me + "/reposts"];
    if (!allowed.includes(path)) {
      if (auto) { ui.log("Otomatik başlatma iptal: bu sayfa kendi profilin değil."); return; }
      alert(
        "Önce kendi profiline git:\n\n" +
        "https://x.com/" + me + "\n\n" +
        "Tek başlatma yeter: Gönderiler, Yanıtlar ve Yeniden gönderiler sekmelerini kendisi gezer."
      );
      return;
    }

    // owner, candidates()'ten ONCE atanmali: aday secimi "bu gonderi bana mi ait"
    // kontrolunu state.owner uzerinden yapar. Once sayarsak owner null olur ve
    // hicbir gonderi aday sayilmaz.
    state.owner = me;

    // Bu sekmedeki aday sayisi yalnizca BILGIDIR; sifir olsa bile islem
    // baslatilir. Cunku gonderiler/yanitlar ile repost'lar AYRI sekmelerdedir:
    // acik sekme bos olabilirken digerinde yuzlerce kayit durabilir. Burada
    // iptal edersek sekme gezme hic devreye giremez.
    const found = candidates().length;

    const total = totalPosts();
    if (auto) {
      state.running = true; state.stop = false;
      ui.busy(true);
      ui.log("OTOMATİK BAŞLATMA (#otomatik): @" + me + (total ? " · " + total + " gönderi" : "") + " — 5 sn içinde HEPSİ silinmeye başlar. İptal için Durdur.");
      for (let i = 5; i > 0; i--) {
        ui.log(i + "…");
        await sleep(1000);
        if (state.stop) { ui.log("İptal edildi."); state.running = false; state.stop = false; state.owner = null; ui.busy(false); return; }
      }
    } else if (!confirm(
      "SON ONAY — @" + me + "\n\n" +
      "HEPSİ SİLİNECEK." + (total ? " Profilinde toplam " + total + " gönderi görünüyor." : "") + "\n\n" +
      "Bu sekmede şu an " + found + " gönderi görünüyor — ama bu bir sınır değil. " +
      "İşlem sayfayı kendisi kaydırır; GÖNDERİLER, YANITLAR ve YENİDEN GÖNDERİLER " +
      "sekmelerini sırayla gezer ve silinecek hiçbir şey kalmayana kadar devam eder.\n\n" +
      "Kendi gönderilerin, yanıtların ve alıntıların KALICI olarak silinir; " +
      "repost'ların geri alınır. Başkasının gönderisine dokunulmaz.\n\n" +
      "GERİ ALINAMAZ. Devam edilsin mi?"
    )) { state.owner = null; return; }

    state.running = true; state.stop = false;
    ui.busy(true); ui.count();
    ui.log("Başladı: @" + me);

    // Baslatildiktan SONRA hicbir sey sorulmaz: bitis ve hata bilgisi de
    // bloklayan pencere yerine panele yazilir, islem kesintisiz akar.
    try {
      await loop(ui);
      ui.log("BİTTİ — silinen: " + state.done + " · atlanan: " + state.failed);
    } catch (e) {
      ui.log("DURDU: " + (e.message || e) + " (silinen: " + state.done + ")");
    } finally {
      state.running = false; state.stop = false;
      ui.busy(false); ui.count();
    }
  }

  // Panel yalnizca bir kez kurulsun (X tek sayfa uygulamasi, yeniden calisabilir).
  if (!window.__xTweetTemizleKurulu) {
    window.__xTweetTemizleKurulu = true;
    const install = () => {
      const ui = buildUI();
      // Profil basligi ve akis yuklensin diye kisa bekleme; begin() kendi
      // hesap/yol dogrulamasini yine yapar.
      if (autoRequested()) setTimeout(() => void begin(ui, true), 2500);
    };
    if (document.body) install();
    else addEventListener("DOMContentLoaded", install, { once: true });
  }
})();
