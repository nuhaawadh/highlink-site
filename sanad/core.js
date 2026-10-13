/**
 * سند الوساطة — المنطق المشترك
 * نفس الملف يشتغل في المتصفح (الوضع التجريبي) وفي Google Apps Script (الخلفية الحقيقية).
 * لا يستخدم import/export: يعرّف متغيرًا عامًا واحدًا اسمه Core.
 */
var Core = (function () {
  var DAY = 864e5, HOUR = 36e5, TZ = 3 * HOUR; // الرياض UTC+3 بدون توقيت صيفي
  var OPEN = ["new", "contact", "view", "neg", "dep", "later"];
  var STAGES = {
    new: "جديد", contact: "تم التواصل", view: "معاينة", neg: "تفاوض",
    dep: "عربون", won: "مغلقة", later: "مؤجل", lost: "خسرناه"
  };
  var STEP_LOG = { contact: "تواصل", view: "معاينة", neg: "تفاوض", dep: "عربون", won: "إغلاق", later: "تأجيل", lost: "خسارة", note: "ملاحظة" };
  var PSTAT = { avail: "متاح", held: "محجوز بعربون", sold: "مباع", rented: "مؤجّر", off: "موقوف" };
  var SOURCES = ["إعلان فال", "سناب", "انستقرام", "اتصال للمكتب", "زيارة للمكتب", "عميل الوسيط", "توصية", "نموذج الموقع"];

  /* أعمدة الجداول — نفس الترتيب في الشيت */
  var SCHEMA = {
    Brokers: ["id", "no", "name", "phone", "fal", "code", "active", "tgChat", "tgToken", "otpHash", "otpExp", "otpTries", "otpSentAt", "createdAt"],
    Properties: ["id", "no", "title", "area", "deal", "price", "status", "closedBy", "falRef", "createdAt", "deedNo", "contractNo", "contractEnd", "subAllowed"],
    Clients: ["id", "no", "name", "phone", "need", "source", "brokerId", "creditBrokerId", "propertyId", "stage", "createdAt", "next", "nextAction", "protectedUntil", "lostReason", "slaNotified", "subContract", "subRemind"],
    Log: ["at", "type", "clientId", "brokerId", "propertyId", "note"],
    Conflicts: ["id", "at", "brokerId", "clientName", "phone", "propertyId", "holderId", "resolved"],
    Sessions: ["hash", "role", "brokerId", "exp", "createdAt"],
    Settings: ["key", "value"]
  };
  var NUMERIC = { at: 1, createdAt: 1, next: 1, protectedUntil: 1, price: 1, slaNotified: 1, otpExp: 1, otpTries: 1, otpSentAt: 1, exp: 1, contractEnd: 1, subRemind: 1 };
  var DEFAULTS = {
    officeName: "المكتب", officeCode: "", officeFal: "", commission: "0.025", coopSplit: "0.5", protectDays: "90", escalateDays: "2",
    leadSlaHours: "2", autoAssign: "1", appUrl: "", botUsername: "", officeTgChat: "", officeTgToken: "", rr: "0", tgOffset: "0",
    seqB: "0", seqP: "0", seqC: "0", tailDays: "60", contractWarnDays: "7", otpHash: "", otpExp: "0", otpTries: "0", otpSentAt: "0"
  };
  var OTP_TTL = 5 * 60 * 1000, OTP_GAP = 60 * 1000, OTP_TRIES = 5, SESSION_DAYS = 30;
  /* رموز المدن لرقم المكتب: XXX-000 */
  var CITIES = { KHB: "الخبر", DMM: "الدمام", DHR: "الظهران", QTF: "القطيف", JBL: "الجبيل", AHS: "الأحساء", RUH: "الرياض", JED: "جدة", MKK: "مكة", MED: "المدينة" };

  /* ---------- أدوات ---------- */
  function toLatin(s) { return String(s == null ? "" : s).replace(/[٠-٩]/g, function (c) { return "٠١٢٣٤٥٦٧٨٩".indexOf(c); }); }
  function p9(s) { return toLatin(s).replace(/\D/g, "").slice(-9); }
  function phone10(s) { var d = p9(s); return d.length === 9 && d.charAt(0) === "5" ? "0" + d : ""; }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function code6() { return String(Math.floor(100000 + Math.random() * 900000)); }
  function token() { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10); }
  function sod(t) { return Math.floor((t + TZ) / DAY) * DAY - TZ; } // بداية اليوم بتوقيت الرياض
  function clean(s, max) { return String(s == null ? "" : s).trim().slice(0, max || 300); }
  function num(s, k) { var v = Number(s && s[k]); return isNaN(v) ? Number(DEFAULTS[k]) : v; }

  function normalize(db) {
    Object.keys(SCHEMA).forEach(function (t) {
      if (t === "Settings") return;
      (db[t] = db[t] || []).forEach(function (r) {
        Object.keys(r).forEach(function (k) {
          if (NUMERIC[k]) r[k] = (r[k] === "" || r[k] == null) ? (k === "next" ? null : 0) : Number(r[k]);
          else if (r[k] == null) r[k] = "";
          else r[k] = String(r[k]);
        });
      });
    });
    db.settings = db.settings || {};
    Object.keys(DEFAULTS).forEach(function (k) { if (db.settings[k] == null || db.settings[k] === "") db.settings[k] = DEFAULTS[k]; });
    // ترقيم السجلات القديمة اللي ما لها رقم
    [["Brokers", "B"], ["Properties", "P"], ["Clients", "C"]].forEach(function (x) {
      db[x[0]].slice().sort(function (a, b) { return a.createdAt - b.createdAt; }).forEach(function (r) {
        if (!r.no) { r.no = serial(db, x[1], r.createdAt || Date.now()); db._migrated = true; }
      });
    });
    return db;
  }

  /* ---------- الترقيم الموحّد ----------
     المكتب:  KHB-001             رمز المدينة + رقم المكتب في الشبكة (تصدره هاي لينك)
     الوسيط:  KHB-001-B0007       رقم المكتب + B + تسلسل الوسيط في المكتب
     العقار:  KHB-001-P0012       رقم المكتب + P + تسلسل العقار
     العميل:  KHB-001-C2610-0042  رقم المكتب + C + سنة وشهر التسجيل + تسلسل العميل
     هوية الوسيط على مستوى السوق كله = رقم رخصة فال، لأنه فريد وطنيًا. */
  function pad(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }
  function officeCode(db) { return /^[A-Z]{3}-\d{3}$/.test(db.settings.officeCode) ? db.settings.officeCode : "OFC-000"; }
  function serial(db, kind, at) {
    var k = "seq" + kind, n = (Number(db.settings[k]) || 0) + 1;
    db.settings[k] = String(n);
    if (kind === "C") { var d = new Date((at || Date.now()) + TZ); return officeCode(db) + "-C" + String(d.getUTCFullYear()).slice(2) + pad(d.getUTCMonth() + 1, 2) + "-" + pad(n, 4); }
    return officeCode(db) + "-" + kind + pad(n, 4);
  }
  /* ---------- عقود الوساطة ----------
     عقد المكتب مع المالك: رقمه وتاريخ انتهائه على العقار. بدونه ما يطلع ترخيص إعلان، والإعلان ينتهي معه.
     الحماية في سند تمتد لنهاية العقد + فترة لاحقة (افتراضيًا ٦٠ يوم) عشان تتطابق مع استحقاق العمولة بعد انتهاء العقد.
     العربون من وسيط متعاون بدون عقد فرعي مسجّل = تنبيه للمكتب يوثّق «عقد وسيط مع وسيط» في المنصة. */
  function contractState(p, now) {
    if (!p || !p.contractNo) return "none";
    if (!p.contractEnd) return "active";
    if (p.contractEnd < sod(now)) return "expired";
    return (p.contractEnd - sod(now)) / DAY <= 7 ? "expiring" : "active";
  }
  function protectUntil(db, c, now) {
    var s = db.settings, base = now + num(s, "protectDays") * DAY, p = prop(db, c.propertyId);
    if (p && p.contractEnd) base = Math.max(base, p.contractEnd + num(s, "tailDays") * DAY);
    return Math.max(c.protectedUntil || 0, base);
  }
  function needsSub(c) { return c.creditBrokerId && c.creditBrokerId !== "office" && !c.subContract && (c.stage === "dep" || c.stage === "won") && c.propertyId; }
  function validFal(s) { var d = toLatin(s).replace(/\D/g, ""); return d.length >= 7 && d.length <= 12 ? d : ""; }

  function S(db) {
    var s = db.settings;
    return {
      officeName: s.officeName, commission: num(s, "commission"), coopSplit: num(s, "coopSplit"),
      protectDays: num(s, "protectDays"), escalateDays: num(s, "escalateDays"), leadSlaHours: num(s, "leadSlaHours"),
      autoAssign: s.autoAssign === "1", appUrl: s.appUrl, botUsername: s.botUsername
    };
  }
  function broker(db, id) { for (var i = 0; i < db.Brokers.length; i++) if (db.Brokers[i].id === id) return db.Brokers[i]; return null; }
  function prop(db, id) { for (var i = 0; i < db.Properties.length; i++) if (db.Properties[i].id === id) return db.Properties[i]; return null; }
  function client(db, id) { for (var i = 0; i < db.Clients.length; i++) if (db.Clients[i].id === id) return db.Clients[i]; return null; }
  function bname(db, id) { if (id === "office") return "المكتب"; var b = broker(db, id); return b ? b.name : "—"; }
  function isOpen(c) { return OPEN.indexOf(c.stage) > -1; }
  function isLate(c, now) { return c.next != null && isOpen(c) && sod(c.next) < sod(now); }
  function isDue(c, now) { return c.next != null && isOpen(c) && sod(c.next) <= sod(now); }
  function log(db, now, type, c, note, brokerId) {
    db.Log.push({ at: now, type: type, clientId: c ? c.id : "", brokerId: brokerId || (c ? c.brokerId : ""), propertyId: c ? c.propertyId : "", note: note || "" });
  }
  function waLink(db, c) {
    var p = prop(db, c.propertyId), office = String(S(db).officeName).split("·")[0].trim();
    var msg = "السلام عليكم " + c.name + "، معك " + bname(db, c.brokerId) + " من " + office + "." +
      (p ? " بخصوص " + p.title + "، حبيت أتابع معك." : " حبيت أطمّن وش صار معك."); // بدون nextAction: ملاحظة داخلية للوسيط، ما تروح للعميل
    return "https://wa.me/966" + p9(c.phone) + "?text=" + encodeURIComponent(msg);
  }
  function tgLink(db, tok) { var u = S(db).botUsername; return u && tok ? "https://t.me/" + u.replace(/^@/, "") + "?start=" + tok : ""; }
  function err(m) { return { ok: false, error: m }; }

  /* ---------- الصلاحيات ---------- */
  /* الدخول على خطوتين:
     1) requestOtp: الوسيط يدخل جواله (والمكتب رمزه) → رمز من ٦ أرقام يوصل على تيليجرام، صالح ٥ دقائق، ٥ محاولات.
        إذا الوسيط لسا ما ربط تيليجرام: يدخل أول مرة برمز الدعوة من المكتب، وبعد الربط يصير الدخول برمز التحقق فقط.
     2) verifyOtp: يتحقق من الرمز ويعطي جلسة صالحة ٣٠ يوم على هذا الجهاز. */
  function brokerByPhone(db, phone) {
    var ph = p9(phone);
    for (var i = 0; i < db.Brokers.length; i++) if (p9(db.Brokers[i].phone) === ph && ph.length === 9) return db.Brokers[i];
    return null;
  }
  function pinOk(d, sec) { return d.pin && sec.officePin && String(d.pin).trim() === String(sec.officePin); }
  function newSession(db, role, brokerId, sec, now) {
    db.Sessions = db.Sessions.filter(function (s) { return s.exp > now; });
    var t = token() + token() + token();
    db.Sessions.push({ hash: sec.hash(t), role: role, brokerId: brokerId || "", exp: now + SESSION_DAYS * DAY, createdAt: now });
    return t;
  }
  function auth(db, a, sec, now) {
    if (!a || !a.token) return null;
    var h = sec.hash(String(a.token));
    for (var i = 0; i < db.Sessions.length; i++) {
      var s = db.Sessions[i];
      if (s.hash !== h || s.exp < now) continue;
      if (s.role === "office") return { role: "office", h: h };
      var b = broker(db, s.brokerId);
      return b && b.active === "1" ? { role: "broker", id: b.id, h: h } : null;
    }
    return null;
  }
  function issueOtp(holder, key, chat, sec, now, out, label) {
    if (now - Number(holder.otpSentAt || 0) < OTP_GAP) return err("انتظر دقيقة قبل ما تطلب رمز جديد.");
    var otp = code6();
    holder.otpHash = sec.hash(key + ":" + otp); holder.otpExp = now + OTP_TTL; holder.otpTries = 0; holder.otpSentAt = now;
    out.notify.push({ to: "chat:" + chat, text: "🔐 رمز دخول " + label + " لنظام سند: " + otp + "\nصالح ٥ دقائق. لا تعطيه لأي أحد، حتى لو قال إنه من المكتب." });
    return { ok: true, channel: "telegram", msg: "أرسلنا رمز التحقق على تيليجرام." };
  }
  function checkOtp(holder, key, code, sec, now) {
    if (!holder.otpHash || Number(holder.otpExp) < now) return err("الرمز انتهى. اطلب رمز جديد.");
    if (Number(holder.otpTries) >= OTP_TRIES) { holder.otpHash = ""; return err("محاولات كثيرة. اطلب رمز جديد."); }
    if (sec.hash(key + ":" + toLatin(code).replace(/\D/g, "")) !== holder.otpHash) { holder.otpTries = Number(holder.otpTries) + 1; return err("الرمز غير صحيح."); }
    holder.otpHash = ""; holder.otpExp = 0; holder.otpTries = 0;
    return { ok: true };
  }
  function requestOtp(db, d, sec, now, out) {
    if (d.role === "office") {
      if (!pinOk(d, sec)) return err("رمز المكتب غير صحيح.");
      if (!db.settings.officeTgChat) return { ok: true, channel: "none" };
      return issueOtp(db.settings, "office", db.settings.officeTgChat, sec, now, out, "إدارة المكتب");
    }
    var b = brokerByPhone(db, d.phone);
    if (!b || b.active !== "1") return err("هذا الرقم غير مسجّل كوسيط أو حسابه موقوف. تواصل مع المكتب.");
    if (!b.tgChat) return { ok: true, channel: "invite", msg: "أول دخول: اكتب رمز الدعوة اللي وصلك من المكتب." };
    return issueOtp(b, b.id, b.tgChat, sec, now, out, b.name);
  }
  function verifyOtp(db, d, sec, now) {
    var r;
    if (d.role === "office") {
      if (!pinOk(d, sec)) return err("رمز المكتب غير صحيح.");
      if (db.settings.officeTgChat) { r = checkOtp(db.settings, "office", d.code, sec, now); if (!r.ok) return r; }
      return { ok: true, token: newSession(db, "office", "", sec, now), who: { role: "office" } };
    }
    var b = brokerByPhone(db, d.phone);
    if (!b || b.active !== "1") return err("هذا الرقم غير مسجّل كوسيط أو حسابه موقوف.");
    if (!b.tgChat) {
      if (Number(b.otpTries) >= OTP_TRIES) return err("محاولات كثيرة. اطلب من المكتب «إعادة تفعيل» عشان يعطيك رمز دعوة جديد.");
      if (String(d.code).trim() !== String(b.code)) { b.otpTries = Number(b.otpTries) + 1; return err("رمز الدعوة غير صحيح."); }
      b.otpTries = 0;
    } else { r = checkOtp(b, b.id, d.code, sec, now); if (!r.ok) return r; }
    return { ok: true, token: newSession(db, "broker", b.id, sec, now), who: { role: "broker", id: b.id } };
  }

  /* ---------- اللقطة اللي تشوفها كل واجهة ---------- */
  function snapshot(db, who, now) {
    var s = S(db);
    var pub = { tailDays: num(db.settings, "tailDays"), officeName: s.officeName, officeCode: officeCode(db), officeFal: db.settings.officeFal, cities: CITIES, commission: s.commission, coopSplit: s.coopSplit, protectDays: s.protectDays, escalateDays: s.escalateDays, sources: SOURCES };
    if (who.role === "office") {
      pub.leadSlaHours = s.leadSlaHours; pub.autoAssign = s.autoAssign; pub.appUrl = s.appUrl; pub.botUsername = s.botUsername;
      return {
        role: "office", now: now, settings: pub,
        officeTg: { linked: !!db.settings.officeTgChat, link: tgLink(db, db.settings.officeTgToken) },
        brokers: db.Brokers.map(function (b) { return { id: b.id, no: b.no, name: b.name, phone: b.phone, fal: b.fal, active: b.active === "1", tgLinked: !!b.tgChat, tgLink: tgLink(db, b.tgToken), sessions: db.Sessions.filter(function (x) { return x.brokerId === b.id && x.exp > now; }).length }; }),
        properties: db.Properties, clients: db.Clients, log: db.Log, conflicts: db.Conflicts
      };
    }
    var me = broker(db, who.id);
    var mine = db.Clients.filter(function (c) { return c.brokerId === me.id || c.creditBrokerId === me.id; });
    var ids = {}; mine.forEach(function (c) { ids[c.id] = 1; });
    return {
      role: "broker", now: now, settings: pub,
      me: { id: me.id, no: me.no, name: me.name, phone: me.phone, fal: me.fal, tgLinked: !!me.tgChat, tgLink: tgLink(db, me.tgToken) },
      brokers: db.Brokers.map(function (b) { return { id: b.id, no: b.no, name: b.name }; }),
      properties: db.Properties.filter(function (p) { return p.status !== "off"; }),
      clients: mine, log: db.Log.filter(function (l) { return ids[l.clientId]; }), conflicts: []
    };
  }

  /* ---------- العمليات ---------- */
  function nextBroker(db) {
    var act = db.Brokers.filter(function (b) { return b.active === "1"; });
    if (!act.length) return null;
    var i = (Number(db.settings.rr) || 0) % act.length;
    db.settings.rr = String(i + 1);
    return act[i];
  }

  function findHolder(db, phone, propertyId, now) {
    var ph = p9(phone);
    for (var i = 0; i < db.Clients.length; i++) {
      var c = db.Clients[i];
      if (p9(c.phone) === ph && (c.propertyId || "") === (propertyId || "") && (isOpen(c) || c.stage === "won") && c.protectedUntil > now) return c;
    }
    return null;
  }

  function addClient(db, who, d, now, out) {
    var s = S(db), name = clean(d.name, 80), phone = phone10(d.phone), propertyId = clean(d.propertyId, 40);
    if (!name) return err("اكتب اسم العميل.");
    if (!phone) return err("رقم الجوال لازم يكون ١٠ أرقام يبدأ بـ 05.");
    if (propertyId && !prop(db, propertyId)) return err("العقار غير موجود.");
    var next = Number(d.next), nextAction = clean(d.nextAction, 160);
    if (!next || !nextAction) return err("حدد موعد المتابعة والخطوة. ما فيه عميل بدون خطوة جاية.");
    var assignTo = who.role === "broker" ? who.id : clean(d.brokerId, 40);
    if (who.role === "office" && assignTo && !broker(db, assignTo)) return err("الوسيط غير موجود.");
    var credit = who.role === "broker" ? who.id : "office";
    var holder = findHolder(db, phone, propertyId, now);
    if (holder) {
      if (holder.creditBrokerId === credit) return err("هذا العميل مسجّل من قبل على نفس الطلب.");
      var cf = { id: uid("f"), at: now, brokerId: credit, clientName: name, phone: phone, propertyId: propertyId, holderId: holder.creditBrokerId, resolved: "" };
      db.Conflicts.push(cf);
      var pp = prop(db, propertyId);
      db.Log.push({ at: now, type: "تعارض", clientId: "", brokerId: credit, propertyId: propertyId, note: bname(db, credit) + " حاول يسجّل «" + name + "»" + (pp ? " على " + pp.title : "") + " وهو محمي لـ " + bname(db, holder.creditBrokerId) });
      out.notify.push({ to: "office", text: "⚠️ تعارض: " + bname(db, credit) + " حاول يسجّل «" + name + "»" + (pp ? " على " + pp.title : "") + " وهو محمي لـ " + bname(db, holder.creditBrokerId) + "." });
      return { ok: false, conflict: true, error: "هذا العميل مسجّل مسبقًا من وسيط آخر وحمايته سارية. انرفع طلبك للمكتب كتعارض." };
    }
    var c = {
      id: uid("c"), no: serial(db, "C", now), name: name, phone: phone, need: clean(d.need, 200) || "—", source: clean(d.source, 40) || "—",
      brokerId: assignTo || "", creditBrokerId: credit, propertyId: propertyId, stage: "new", createdAt: now,
      next: next, nextAction: nextAction, protectedUntil: 0, lostReason: "", slaNotified: 0, subContract: "", subRemind: 0
    };
    c.protectedUntil = protectUntil(db, c, now);
    db.Clients.push(c);
    log(db, now, "تسجيل", c, "", credit === "office" ? assignTo || "office" : credit);
    if (who.role === "office" && assignTo) notifyAssigned(db, c, out, "عميل جديد من المكتب");
    var pc = prop(db, propertyId), warn = pc && contractState(pc, now) === "expired" ? " تنبيه: عقد الوساطة على هذا العقار منتهي، بلّغ المكتب." : pc && contractState(pc, now) === "none" ? " تنبيه: هذا العقار ما عليه عقد وساطة مسجّل." : "";
    return { ok: true, client: c, msg: (who.role === "broker" ? "انحمى «" + name + "» باسمك حتى " + new Date(c.protectedUntil + TZ).toISOString().slice(0, 10) + "." : "انضاف «" + name + "».") + warn };
  }

  function notifyAssigned(db, c, out, title) {
    var p = prop(db, c.propertyId);
    out.notify.push({
      to: c.brokerId, text: "🆕 " + title + ": " + c.name + "\n" + (p ? p.title : c.need) + "\nالخطوة: " + c.nextAction,
      buttons: [{ text: "راسل " + c.name + " على واتساب", url: waLink(db, c) }]
    });
  }

  function logStep(db, who, d, now, out) {
    var c = client(db, d.clientId);
    if (!c) return err("العميل غير موجود.");
    if (who.role === "broker" && c.brokerId !== who.id) return err("هذا العميل مو في قائمة متابعتك.");
    var t = d.type, note = clean(d.note, 300);
    if (!STEP_LOG[t]) return err("نوع الخطوة غير معروف.");
    var end = t === "won" || t === "lost";
    if (!end && (!Number(d.next) || !clean(d.nextAction))) return err("حدد موعد وخطوة المتابعة الجاية.");
    if (t === "lost" && !note) return err("اكتب سبب الخسارة.");
    var p = prop(db, c.propertyId);
    if (t !== "note") c.stage = t;
    if (end) { c.next = null; c.nextAction = ""; } else { c.next = Number(d.next); c.nextAction = clean(d.nextAction, 160); }
    if (t === "lost") c.lostReason = note;
    if (p && t === "dep") p.status = "held";
    if (p && t === "won") { p.status = p.deal === "إيجار" ? "rented" : "sold"; p.closedBy = c.creditBrokerId; }
    c.protectedUntil = protectUntil(db, c, now);
    c.slaNotified = 1;
    log(db, now, STEP_LOG[t], c, note, who.role === "broker" ? who.id : c.brokerId);
    if (t === "won") out.notify.push({ to: "office", text: "🎉 صفقة: " + bname(db, c.creditBrokerId) + " قفل " + (p ? p.title : "طلب") + " مع «" + c.name + "»" + (note ? " · " + note : "") });
    if (t === "dep") out.notify.push({ to: "office", text: "💰 عربون: «" + c.name + "»" + (p ? " على " + p.title : "") + " عن طريق " + bname(db, c.brokerId) + (note ? " · " + note : "") });
    if ((t === "dep" || t === "won") && needsSub(c)) {
      c.subRemind = now;
      out.notify.push({ to: "office", text: "📝 «" + c.name + "» جابه " + bname(db, c.creditBrokerId) + " (وسيط متعاون) ووصل " + (t === "won" ? "للإغلاق" : "للعربون") + ".\nوثّق «عقد وسيط مع وسيط» في منصة الهيئة" + (p && p.deedNo ? " على الصك " + p.deedNo : "") + "، وسجّل رقمه في سند عند العميل." });
    }
    return { ok: true, msg: t === "won" ? "مبروك! انسجّلت الصفقة." : "انحفظت الخطوة." };
  }

  function reassign(db, d, now, out) {
    var c = client(db, d.clientId), b = broker(db, d.brokerId);
    if (!c || !b) return err("اختر العميل والوسيط.");
    if (b.active !== "1") return err("هذا الوسيط موقوف.");
    var prevId = c.brokerId, from = prevId ? bname(db, prevId) : "بدون وسيط";
    if (prevId && prevId !== b.id) out.notify.push({ to: prevId, text: "↪️ عميلك «" + c.name + "» تحوّل لـ " + b.name + " يتابعه." + (c.creditBrokerId === prevId ? "\nحق الصفقة باقي لك." : "") });
    c.brokerId = b.id; c.next = Number(d.next) || now; c.slaNotified = 0;
    if (!c.nextAction) c.nextAction = "متابعة بعد التحويل";
    log(db, now, "تحويل", c, "من " + from + " إلى " + b.name, b.id);
    notifyAssigned(db, c, out, "تحوّل لك عميل");
    return { ok: true, msg: "تحوّل العميل إلى " + b.name + "." };
  }

  function lead(db, d, now, out) {
    if (d.website) return { ok: true, msg: "وصل طلبك." }; // حقل فخ للسبام
    var s = S(db), name = clean(d.name, 80), phone = phone10(d.phone);
    if (!name || !phone) return err("اكتب اسمك ورقم جوال صحيح يبدأ بـ 05.");
    var propertyId = prop(db, d.propertyId) ? d.propertyId : "";
    var existing = findHolder(db, phone, propertyId, now);
    if (existing) {
      log(db, now, "ملاحظة", existing, "العميل رجع تواصل من النموذج: " + clean(d.need, 200), existing.brokerId);
      if (existing.brokerId) out.notify.push({ to: existing.brokerId, text: "🔁 عميلك «" + existing.name + "» رجع تواصل من النموذج.\n" + clean(d.need, 200), buttons: [{ text: "راسله على واتساب", url: waLink(db, existing) }] });
      return { ok: true, msg: "وصل طلبك، بيتواصل معك فريقنا قريب." };
    }
    var b = s.autoAssign ? nextBroker(db) : null;
    var c = {
      id: uid("c"), no: serial(db, "C", now), name: name, phone: phone, need: clean(d.need, 200) || "—", source: clean(d.source, 40) || "نموذج الموقع",
      brokerId: b ? b.id : "", creditBrokerId: "office", propertyId: propertyId, stage: "new", createdAt: now,
      next: now, nextAction: "أول تواصل خلال " + s.leadSlaHours + " ساعات", protectedUntil: 0, lostReason: "", slaNotified: 0, subContract: "", subRemind: 0
    };
    c.protectedUntil = protectUntil(db, c, now);
    db.Clients.push(c);
    log(db, now, "تسجيل", c, "من " + c.source, b ? b.id : "office");
    if (b) notifyAssigned(db, c, out, "عميل جديد وصل الحين");
    out.notify.push({ to: "office", text: "📥 عميل جديد من " + c.source + ": " + c.name + (b ? " → " + b.name : " (بدون وسيط، وزّعه من اللوحة)") });
    return { ok: true, msg: "وصل طلبك، بيتواصل معك فريقنا قريب." };
  }

  function addBroker(db, d, now) {
    var name = clean(d.name, 80), phone = phone10(d.phone), fal = d.fal ? validFal(d.fal) : "";
    if (!name || !phone) return err("اكتب اسم الوسيط وجوال صحيح.");
    if (d.fal && !fal) return err("رقم رخصة فال لازم يكون أرقام فقط (٧ إلى ١٢ رقم).");
    for (var j = 0; j < db.Brokers.length; j++) if (fal && db.Brokers[j].fal === fal) return err("رخصة فال هذي مسجّلة لوسيط ثاني.");
    for (var i = 0; i < db.Brokers.length; i++) if (p9(db.Brokers[i].phone) === p9(phone)) return err("هذا الجوال مسجّل لوسيط من قبل.");
    var b = { id: uid("b"), no: serial(db, "B", now), name: name, phone: phone, fal: fal, code: code6(), active: "1", tgChat: "", tgToken: token(), otpHash: "", otpExp: 0, otpTries: 0, otpSentAt: 0, createdAt: now };
    db.Brokers.push(b);
    return { ok: true, invite: invite(db, b), msg: "انضاف " + name + "." };
  }
  function invite(db, b) {
    var s = S(db);
    return {
      name: b.name, no: b.no, phone: b.phone, code: b.code, tgLink: tgLink(db, b.tgToken),
      text: "هلا " + b.name + "، انضفت لنظام «سند» في " + s.officeName + ".\n" +
        "رقمك كوسيط: " + b.no + "\n" +
        (s.appUrl ? "رابط لوحتك: " + s.appUrl + "\n" : "") +
        "١) اربط تيليجرام عشان توصلك رموز الدخول ومتابعات يومك" + (tgLink(db, b.tgToken) ? ": " + tgLink(db, b.tgToken) : " (الرابط يجيك من المكتب)") + "\n" +
        "٢) أول دخول برقم جوالك " + b.phone + " ورمز الدعوة: " + b.code + "\n" +
        "بعد ربط تيليجرام يصير الدخول برمز تحقق يوصلك كل مرة.\n" +
        "القاعدة: سجّل عميلك قبل أي معاينة، واللي ما سجّل ما له حماية."
    };
  }
  function updateBroker(db, d) {
    var b = broker(db, d.id);
    if (!b) return err("الوسيط غير موجود.");
    var kill = function () { db.Sessions = db.Sessions.filter(function (x) { return x.brokerId !== b.id; }); };
    if (d.active != null) { b.active = d.active ? "1" : "0"; if (!d.active) kill(); }
    if (d.fal != null) { var f = validFal(d.fal); if (d.fal && !f) return err("رقم رخصة فال لازم يكون أرقام فقط (٧ إلى ١٢ رقم)."); b.fal = f; return { ok: true, msg: "انحفظت الرخصة." }; }
    if (d.resetCode) { b.code = code6(); b.tgToken = token(); b.tgChat = ""; b.otpHash = ""; b.otpTries = 0; kill(); return { ok: true, invite: invite(db, b), msg: "انعمل رمز دعوة جديد، وانفصل تيليجرام القديم، وخرج من كل الأجهزة." }; }
    return { ok: true, msg: b.active === "1" ? "الوسيط مفعّل." : "انوقف الوسيط. عملاؤه يبقون ويقدر المكتب يحوّلهم." };
  }
  function saveProperty(db, d, now) {
    var title = clean(d.title, 120), price = Number(toLatin(d.price).replace(/[^\d.]/g, ""));
    if (!title) return err("اكتب وصف العقار.");
    if (!price) return err("اكتب السعر بالأرقام.");
    var deal = d.deal === "إيجار" ? "إيجار" : "بيع";
    var st = PSTAT[d.status] ? d.status : "avail";
    var ce = d.contractEnd ? Number(d.contractEnd) : 0;
    if (clean(d.contractNo) && !ce) return err("اكتب تاريخ انتهاء عقد الوساطة.");
    var p = d.id ? prop(db, d.id) : null;
    if (d.id && !p) return err("العقار غير موجود.");
    if (!p) { p = { id: uid("p"), no: serial(db, "P", now), closedBy: "", createdAt: now }; db.Properties.push(p); }
    p.title = title; p.area = clean(d.area, 40); p.deal = deal; p.price = price; p.status = st; p.falRef = clean(d.falRef, 40);
    p.deedNo = toLatin(clean(d.deedNo, 30)); p.contractNo = toLatin(clean(d.contractNo, 30)); p.contractEnd = p.contractNo ? ce : 0; p.subAllowed = d.subAllowed === false || d.subAllowed === "0" ? "0" : "1";
    // تجديد العقد يمدّ حماية العملاء النشطين على العقار
    db.Clients.forEach(function (c) { if (c.propertyId === p.id && (isOpen(c) || c.stage === "won")) c.protectedUntil = protectUntil(db, c, now); });
    if (st === "avail" || st === "off") p.closedBy = "";
    return { ok: true, msg: d.id ? "انحفظ العقار." : "انضاف العقار." };
  }

  function handle(db, req, secrets, now) {
    normalize(db);
    now = now || Date.now();
    var sec = secrets || {}, out = { notify: [] }, res, d = req.data || {};
    if (!sec.hash) return err("إعداد الخادم ناقص.");
    var mig = !!db._migrated; delete db._migrated;
    var fin = function (r, dirty) { r.dirty = !!dirty || mig; r.notify = out.notify; return r; };
    if (req.action === "lead") { res = lead(db, d, now, out); return fin(res, res.ok); }
    if (req.action === "requestOtp") { res = requestOtp(db, d, sec, now, out); return fin(res, res.ok && res.channel === "telegram"); }
    if (req.action === "verifyOtp") {
      res = verifyOtp(db, d, sec, now);
      if (res.ok) { res.snapshot = snapshot(db, res.who, now); delete res.who; }
      return fin(res, true);
    }
    var who = auth(db, req.auth, sec, now);
    if (!who) return fin({ ok: false, expired: true, error: "انتهت الجلسة أو الحساب موقوف. سجّل دخولك من جديد." }, false);
    var dirty = true;
    switch (req.action) {
      case "snapshot": res = { ok: true }; dirty = false; break;
      case "logout": db.Sessions = db.Sessions.filter(function (x) { return x.hash !== who.h; }); return fin({ ok: true }, true);
      case "addClient": res = addClient(db, who, d, now, out); break;
      case "logStep": res = logStep(db, who, d, now, out); break;
      default:
        if (who.role !== "office") return fin(err("هذه العملية للمكتب فقط."), false);
        if (req.action === "reassign") res = reassign(db, d, now, out);
        else if (req.action === "addBroker") res = addBroker(db, d, now);
        else if (req.action === "updateBroker") res = updateBroker(db, d);
        else if (req.action === "saveProperty") res = saveProperty(db, d, now);
        else if (req.action === "resolveConflict") {
          var cf = db.Conflicts.filter(function (x) { return x.id === d.id; })[0];
          res = cf ? (cf.resolved = "1", { ok: true, msg: "انقفل التعارض." }) : err("التعارض غير موجود.");
        }
        else if (req.action === "settings") res = saveSettings(db, d);
        else if (req.action === "setSubContract") {
          var sc = client(db, d.clientId), no = toLatin(clean(d.no, 30));
          if (!sc) res = err("العميل غير موجود.");
          else if (!no) res = err("اكتب رقم عقد الوسيط مع الوسيط من المنصة.");
          else { sc.subContract = no; log(db, now, "عقد فرعي", sc, "رقم " + no, sc.creditBrokerId); res = { ok: true, msg: "انسجّل العقد الفرعي." }; }
        }
        else res = err("طلب غير معروف.");
    }
    fin(res, dirty && (res.ok || res.conflict));
    res.snapshot = snapshot(db, who, now);
    return res;
  }

  function saveSettings(db, d) {
    if (d.officeCode != null && d.officeCode !== "") {
      var code = String(d.officeCode).trim().toUpperCase();
      if (!/^[A-Z]{3}-\d{3}$/.test(code)) return err("رقم المكتب لازم يكون بالشكل KHB-001: رمز المدينة ثلاث حروف، ثم رقم من ثلاث خانات.");
      var old = officeCode(db);
      if (code !== old) {
        db.settings.officeCode = code;
        ["Brokers", "Properties", "Clients"].forEach(function (t) { db[t].forEach(function (r) { if (r.no && r.no.indexOf(old + "-") === 0) r.no = code + r.no.slice(old.length); }); });
      }
    }
    if (d.officeFal != null && d.officeFal !== "") { var f = validFal(d.officeFal); if (!f) return err("رقم رخصة فال للمكتب لازم يكون أرقام فقط (٧ إلى ١٢ رقم)."); db.settings.officeFal = f; }
    ["officeName", "commission", "coopSplit", "protectDays", "escalateDays", "leadSlaHours", "autoAssign", "appUrl", "botUsername", "tailDays"].forEach(function (k) { if (d[k] != null) db.settings[k] = clean(d[k], 200); });
    return { ok: true, msg: "انحفظت الإعدادات." };
  }

  /* ---------- مهام مجدولة ---------- */
  function digest(db, now) {
    normalize(db);
    var s = S(db), list = [];
    db.Brokers.forEach(function (b) {
      if (b.active !== "1" || !b.tgChat) return;
      var due = db.Clients.filter(function (c) { return c.brokerId === b.id && isDue(c, now); }).sort(function (a, z) { return a.next - z.next; });
      if (!due.length) return;
      var late = due.filter(function (c) { return isLate(c, now); }).length;
      var lines = due.slice(0, 12).map(function (c, i) {
        var p = prop(db, c.propertyId);
        return (i + 1) + ". " + c.name + (isLate(c, now) ? " (متأخرة " + Math.round((sod(now) - sod(c.next)) / DAY) + " يوم)" : "") + "\n   " + c.nextAction + (p ? " · " + p.title : "");
      });
      list.push({
        to: b.id, text: "صباح الخير " + b.name.split(" ")[0] + " ☀️\nعندك " + due.length + " متابعات اليوم" + (late ? "، منها " + late + " متأخرة" : "") + ":\n\n" + lines.join("\n"),
        buttons: due.slice(0, 8).map(function (c) { return { text: "واتساب: " + c.name, url: waLink(db, c) }; }).concat(s.appUrl ? [{ text: "افتح لوحتي", url: s.appUrl }] : [])
      });
    });
    var lateAll = db.Clients.filter(function (c) { return isLate(c, now) && (sod(now) - sod(c.next)) / DAY >= s.escalateDays; });
    var live = db.Properties.filter(function (p) { return p.status === "avail" || p.status === "held"; });
    var expiring = live.filter(function (p) { var st = contractState(p, now); return st === "expiring"; });
    var expired = live.filter(function (p) { return contractState(p, now) === "expired"; });
    var noContract = live.filter(function (p) { return contractState(p, now) === "none"; });
    var noSub = db.Clients.filter(needsSub);
    var unassigned = db.Clients.filter(function (c) { return isOpen(c) && !c.brokerId; });
    var conf = db.Conflicts.filter(function (x) { return x.resolved !== "1"; });
    var byB = {};
    lateAll.forEach(function (c) { byB[c.brokerId] = (byB[c.brokerId] || 0) + 1; });
    var parts = ["ملخص " + s.officeName + " اليوم:",
      "• عملاء نشطين: " + db.Clients.filter(function (c) { return isOpen(c) && c.stage !== "later"; }).length,
      "• متابعات متأخرة أكثر من " + s.escalateDays + " يوم: " + lateAll.length + (lateAll.length ? " (" + Object.keys(byB).map(function (k) { return bname(db, k) + " " + byB[k]; }).join("، ") + ")" : ""),
      "• عملاء بدون وسيط: " + unassigned.length, "• تعارضات مفتوحة: " + conf.length];
    if (expiring.length) parts.push("• عقود وساطة تنتهي خلال أسبوع: " + expiring.map(function (p) { return p.title; }).join("، "));
    if (expired.length) parts.push("• عقود منتهية والعقار لسا معروض (الإعلان موقوف نظامًا): " + expired.map(function (p) { return p.title; }).join("، "));
    if (noContract.length) parts.push("• عقارات معروضة بدون عقد وساطة مسجّل: " + noContract.length);
    if (noSub.length) parts.push("• عربون/إغلاق من وسيط متعاون بدون عقد فرعي: " + noSub.map(function (c) { return c.name; }).join("، "));
    list.push({ to: "office", text: parts.join("\n"), buttons: s.appUrl ? [{ text: "افتح لوحة المكتب", url: s.appUrl }] : [] });
    return list;
  }

  function slaCheck(db, now) {
    normalize(db);
    var s = S(db), list = [];
    db.Clients.forEach(function (c) {
      if (c.stage !== "new" || c.slaNotified || now - c.createdAt < s.leadSlaHours * HOUR) return;
      c.slaNotified = 1;
      list.push({ to: "office", text: "⏰ «" + c.name + "» صار له " + s.leadSlaHours + " ساعات بدون تواصل" + (c.brokerId ? " مع " + bname(db, c.brokerId) : " وما له وسيط") + ". تقدر تحوّله من اللوحة." });
      if (c.brokerId) list.push({ to: c.brokerId, text: "⏰ «" + c.name + "» ينتظر تواصلك من " + s.leadSlaHours + " ساعات.", buttons: [{ text: "راسله الحين", url: waLink(db, c) }] });
    });
    return list;
  }

  /* رسالة وصلت للبوت: ربط الوسيط أو المكتب بتيليجرام */
  function telegram(db, msg) {
    normalize(db);
    var text = String(msg && msg.text || ""), chat = String(msg && msg.chat && msg.chat.id || "");
    if (!chat) return null;
    var m = toLatin(text).replace(/[۰-۹]/g, function (c) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(c); })
      .replace(/[‎‏‪-‮⁦-⁩﻿]/g, "").match(/^\s*\/start\s+(\S+)/);
    if (m) m[1] = m[1].replace(/[^a-z0-9]/gi, ""); // الرموز حروف وأرقام فقط، ونشيل أي علامة اتجاه أو رمز انلصق مع النسخ
    if (!m) return { chat: chat, text: "هذا بوت «سند» للتنبيهات. افتح رابط الربط اللي وصلك من المكتب عشان تنربط." };
    if (m[1] === db.settings.officeTgToken) { db.settings.officeTgChat = chat; return { chat: chat, text: "تم ربط إدارة " + S(db).officeName + " ✅\nبيوصلك الملخص اليومي والتعارضات والصفقات هنا.", dirty: true }; }
    for (var i = 0; i < db.Brokers.length; i++) {
      var b = db.Brokers[i];
      if (b.tgToken && b.tgToken === m[1]) { b.tgChat = chat; return { chat: chat, text: "هلا " + b.name + " ✅\nانربط حسابك. من الحين رموز الدخول توصلك هنا، وكل صباح متابعات يومك، وأي عميل جديد يتحوّل لك.", dirty: true }; }
    }
    return { chat: chat, text: "الرابط غير صحيح أو انتهى. اطلب رابطًا جديدًا من المكتب.\n(الرمز اللي وصلني: " + m[1] + ")" };
  }

  function chatFor(db, to) { if (String(to).indexOf("chat:") === 0) return String(to).slice(5); if (to === "office") return db.settings.officeTgChat; var b = broker(db, to); return b && b.active === "1" ? b.tgChat : ""; }

  return {
    SCHEMA: SCHEMA, NUMERIC: NUMERIC, CITIES: CITIES, contractState: contractState, needsSub: needsSub, DEFAULTS: DEFAULTS, STAGES: STAGES, PSTAT: PSTAT, OPEN: OPEN, DAY: DAY,
    handle: handle, digest: digest, slaCheck: slaCheck, telegram: telegram, chatFor: chatFor, normalize: normalize,
    p9: p9, sod: sod, waLink: waLink, token: token, code6: code6
  };
})();
if (typeof module !== "undefined") module.exports = Core;
