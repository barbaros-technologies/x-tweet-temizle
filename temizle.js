// X Tweet Temizle v1 — Barbaros Technologies, MIT.
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
  const SCROLL_TRIES = 6;      // aday bulunmayinca kac kez kaydirip bakalim
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
  // Gonderiler+yanitlar bir sekmede, RT'ler AYRI sekmededir ve birbirinde hic
  // gorunmezler. Tek baslatmada hepsini temizlemek icin sekmeleri kendimiz
  // geziyoruz. X tek sayfa uygulamasi oldugundan sekme baglantisina tiklamak
  // sayfayi yeniden yuklemez; script calismaya devam eder.
  const TABS = ["with_replies", "reposts"];

  function currentTab() {
    const p = location.pathname.toLowerCase().replace(/\/$/, "");
    const base = "/" + state.owner;
    return p === base ? "" : p.slice(base.length + 1);
  }

  async function gotoTab(ui, tab) {
    const target = "/" + state.owner + "/" + tab;
    const link = [...document.querySelectorAll('a[role="tab"]')].find((a) => {
      try { return new URL(a.href, location.origin).pathname.toLowerCase().replace(/\/$/, "") === target; }
      catch (_) { return false; }
    });
    if (!link) { ui.log("Sekme bağlantısı bulunamadı: " + tab); return false; }
    link.click();
    const ok = await waitFor(() => currentTab() === tab ? true : null);
    if (!ok) { ui.log("Sekmeye geçilemedi: " + tab); return false; }
    await sleep(2500);   // zaman akisinin yuklenmesini bekle
    return true;
  }

  // ---- Ana dongu ------------------------------------------------------------
  // Her sekmeyi sirayla, silinecek gonderi kalmayana kadar temizler.
  async function loop(ui) {
    for (const tab of TABS) {
      if (state.stop) return;
      if (currentTab() !== tab) {
        ui.log("--- sekme: " + tab + " ---");
        if (!(await gotoTab(ui, tab))) continue;
      } else {
        ui.log("--- sekme: " + tab + " ---");
      }
      await clearTab(ui);
    }
  }

  async function clearTab(ui) {
    let emptyScrolls = 0;
    let streak = 0;   // ust uste basarisiz islem sayaci
    while (!state.stop) {
      guard();
      const list = candidates();

      if (!list.length) {
        if (emptyScrolls >= SCROLL_TRIES) { ui.log("Silinecek gönderi kalmadı (bu sayfada)."); return; }
        emptyScrolls++;
        ui.log("Aday yok, kaydırılıyor… (" + emptyScrolls + "/" + SCROLL_TRIES + ")");
        scrollTo(0, document.body.scrollHeight);
        await sleep(1500);
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
    title.textContent = "X Tweet Temizle v1.6";
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

    start.addEventListener("click", () => void begin(ui));
    stop.addEventListener("click", () => { state.stop = true; ui.log("Durduruluyor…"); });
    return ui;
  }

  // ---- Baslatma -------------------------------------------------------------
  async function begin(ui) {
    if (state.running) return;

    const me = currentUser();
    if (!me) { alert("Açık X hesabı doğrulanamadı. Sayfayı yenileyip tekrar dene."); return; }

    // Yalnizca kendi profil sayfanda calis: baskasinin akisinda yanlislikla islem yapma.
    // Kendi profilinin sekmeleri. RT'ler ayri bir sekmede (/reposts) durur ve
    // diger sekmelerde hic gorunmez; o sekme izinli olmazsa RT'ler asla silinmez.
    const path = location.pathname.toLowerCase().replace(/\/$/, "");
    const allowed = ["/" + me, "/" + me + "/with_replies", "/" + me + "/reposts"];
    if (!allowed.includes(path)) {
      alert(
        "Önce kendi profilinin şu sekmelerinden birine git:\n\n" +
        "Gönderiler + yanıtlar:  https://x.com/" + me + "/with_replies\n" +
        "Repost'lar:              https://x.com/" + me + "/reposts\n\n" +
        "Tek başlatma yeter: ikisini de kendisi gezer."
      );
      return;
    }

    // owner, candidates()'ten ONCE atanmali: aday secimi "bu gonderi bana mi ait"
    // kontrolunu state.owner uzerinden yapar. Once sayarsak owner null olur ve
    // hicbir gonderi aday sayilmaz.
    state.owner = me;

    const diag = {};
    const found = candidates(diag).length;
    if (!found) {
      state.owner = null;
      alert(
        "Bu sayfada silinecek gönderi görünmüyor.\n\n" +
        "TEŞHİS (v1.6) — hesap: @" + me + "\n" +
        "gönderi kutusu (article): " + diag.article + "\n" +
        "görünür: " + diag.gorunur + "\n" +
        "kimliği çözülen: " + diag.kimlik + "\n" +
        "daha önce atlanan: " + diag.atlanan + "\n" +
        "bana ait sayılan: " + diag.benim + "\n" +
        "sil düğmesi bulunan: " + diag.caret + "\n\n" +
        "Bu satırları olduğu gibi ilet."
      );
      return;
    }

    const total = totalPosts();
    if (!confirm(
      "SON ONAY — @" + me + "\n\n" +
      "HEPSİ SİLİNECEK." + (total ? " Profilinde toplam " + total + " gönderi görünüyor." : "") + "\n\n" +
      "İşlem şu an ekranda görünen " + found + " gönderiyle başlar, sonra sayfayı " +
      "kendisi kaydırıp yenilerini yükler ve silinecek gönderi kalmayana kadar DEVAM EDER. " +
      "Yani bu " + found + " sayısı bir sınır değildir.\n\n" +
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
    if (document.body) buildUI();
    else addEventListener("DOMContentLoaded", buildUI, { once: true });
  }
})();
