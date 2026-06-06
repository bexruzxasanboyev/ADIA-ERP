# ADIA ERP — Telegram Bot TZ (to'liq)

> Manba: egasi (2026-06-06). Bot: **@adiaerpbot** (id 8943934740). Stack: Grammy + Vertex Gemini.
> Token `.env`да (`BOT_TOKEN`), gitignored.

## 1. Maqsad (bot asosiy vazifasi)
1. **Bo'limlar aro so'rov yuborish** — har bo'lim boshlig'i o'z ustki bo'g'iniga so'rov yuboradi (do'kon→markaziy, markaziy→ishlab chiqarish, sex→sklad, ...).
2. **So'rovni qabul qilish/rad etish** — maqsad bo'lim boshlig'i kelgan so'rovni Telegram'da inline tugma bilan qabul/rad qiladi.
3. **Ovozli (STT) so'rov shakllantirish** — boshliq ovozli xabar yuboradi → bot tushunadi → so'rovga aylantiradi → tasdiq.

## 2. STT — Gemini 2.5 Flash (Yandex o'rniga)
- **Hozir:** Yandex SpeechKit (uz-UZ) → matn → Gemini intent. 
- **Bo'ladi:** audio to'g'ridan-to'g'ri **Gemini 2.5 Flash**ga (`@google/genai` `inlineData` audio part) → bitta chaqiruvda transkripsiya + struktura (function calling `parse_request`). Yandex bog'liqligi olib tashlanadi (proaudit.app shu yondashuv — audio→Gemini).
- **Aniqlik (egasi urg'usi):** promt **o'zbek tilida**; mahsulotlar **ruscha nom** bilan (НАПОЛЕОН, ПЕЛЬМЕНИ...). Promtга do'kon assortimenti (ruscha nomlar) kontekst sifatida beriladi → o'zbekcha nutq ruscha nomга adashmay map bo'ladi. Misol: "menga yigirmata napoleon kerak" → `{product: "НАПОЛЕОН", qty: 20}`.

## 3. Onboarding — har user o'z bo'limida (egasi urg'usi)
- `/start <token>` → `users.telegram_id` bog'lanadi (mavjud).
- **Yangi:** bog'langach bot **o'z bo'limiga** tushiradi — "Salom {ism}, siz {bo'lim} ({rol}) boshlig'isiz" + **rolга qarab menyu** (reply keyboard):
  - **store_manager:** 🎤 Ovozli so'rov · ➕ So'rov yuborish · 📥 Kelgan so'rovlar · 📦 Mahsulotlar
  - **central_warehouse_manager / production_manager / ...:** 📥 Kelgan so'rovlar · 🎤 Ovozli so'rov · ⬆️ Yuqoriga so'rov
  - **pm (manager):** faqat ko'rish — 📊 holat (action yo'q)
- Har keyingi `/start` (linked) → to'g'ri o'z menyusiga qaytadi.

## 4. Oqim (end-to-end)
1. Boshliq menyudan **🎤 Ovozli so'rov** yoki **➕ So'rov yuborish**.
2. Ovoz: audio→Gemini 2.5 Flash→`parse_request` (product+qty ro'yxati). Matn: mahsulot tanlash + soni.
3. Bot tasdiq ko'rsatadi: "📝 Eshitdim: ... → НАПОЛЕОН ×20, ПЕЛЬМЕНИ ×50 — to'g'rimi?" + ✅ Tasdiqlash / ✏️ / ❌.
4. Tasdiqlanса → **replenishment request** yaratiladi (requester = boshliqning bo'limi; target = ustki bo'g'in — topology orqali).
5. **Target bo'lim boshlig'iga** Telegram bildirishnoma + **✅ Qabul / ❌ Rad** tugmalari.
6. Qabul → engine do'konга jo'natadi (SHIP) / yetmasa ishlab chiqarishга. Rad → CANCELLED (sabab).
7. So'rovchiга natija bildirishnomasi (qabul qilindi / rad etildi / jo'natildi).

## 5. Hozir BOR (qayta ishlatamiz)
- /start linking (`users.telegram_id`, link_tokens), `loadVoicePrincipal` (telegram_id→user+rol+lokatsiya).
- voiceHandler: ovoz yuklash, intent parse (Gemini), product/location resolve, pending `assistant_actions`, tasdiq tugmalari.
- dispatch.ts + callbackHandler: callback RBAC + idempotency + audit; verb'lar (apprv:po, fast:req, apprv:act...).
- telegramOutbox: bildirishnoma yuborish (inline keyboard bilan).
- Replenishment engine + yangi endpointlar (batch, proposals, accept-central, receive).

## 6. GAP (quriladi)
- **STT → Gemini 2.5 Flash audio** (Yandex o'rniga); o'zbek promt + ruscha mahsulot kontekst.
- **Onboarding menyu** — /start'dan keyin rolга qarab bo'lim menyusi.
- **Bo'limlar aro so'rov yuborish** — ovoz/menyu → replenishment request (requester=o'z bo'lim, target=ustki bo'g'in).
- **Qabul/rad callback** — target boshliqга tugma; `xreq:accept` / `xreq:reject` verb (accept-central/reject-central logikasini qayta ishlat).
- **Reply-keyboard menyu** + matnli "So'rov yuborish" sahnasi (product select + qty).

## 7. Implementatsiya rejasi
- **B1** STT: voiceHandler'да `recognizeShort` (Yandex) o'rniga Gemini 2.5 Flash audio (`vertex/client` audio part). O'zbek promt + assortiment kontekst. Yandex env ixtiyoriy bo'lib qoladi (fallback).
- **B2** Onboarding: startCommand'да linked user → rol-menyu (reply keyboard) + "o'z bo'limi" salomlash.
- **B3** Bo'limlar aro so'rov: voice/menu intent → `createRequest` (target = topology ustki bo'g'in) → target boshliqга bildirishnoma + qabul/rad tugma.
- **B4** Callback: `xreq:accept`/`xreq:reject` dispatch + RBAC (faqat target bo'lim boshlig'i).
- **B5** Test: STT (audio fixture), onboarding menyu, so'rov yaratish+qabul, RBAC.

## 8. Xavfsizlik
- Token `.env`да (gitignored). Eski token tarixда — kerak bo'lsa rotatsiya.
- Har callback: telegram_id→user spoofing-check + RBAC + idempotency + audit (mavjud).
