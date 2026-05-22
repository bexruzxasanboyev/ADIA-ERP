# ADIA ERP — Qarorlar jurnali (Decisions Log)

Loyiha bo'yicha qabul qilingan asosiy qarorlar shu yerda yoziladi. Yangi qaror — tepaga, sana bilan.

---

## 2026-05-22 — TZ §16 ochiq savollari hal qilindi

Loyiha egasi tomonidan tasdiqlangan qarorlar:

### D1. Xom-ashyo ombori va Markaziy Sklad — alohida fizik omborlar
Mahsulotlar Ombori (xom-ashyo) va Markaziy Sklad — **alohida fizik omborlar**. `locations` jadvalida ikki alohida yozuv (`type = raw_warehouse` va `type = central_warehouse`).

### D2. Yarim Fabrika — ikki tomonlama oqim
Yarim Fabrika **ham Markaziy Skladga, ham Ishlab chiqarishga** beradi:
- Markaziy Skladga — jo'natma (`shipment`) sifatida;
- Ishlab chiqarishga — BOM komponenti sifatida qayta kirish.
DB sxemasi va logika ikkala oqimni ham qo'llab-quvvatlashi shart.

### D3. Dinamik min/max — barcha bo'g'inlarda
Sotuvga bog'langan dinamik min/max **har bir bo'g'in (location)** uchun ishlaydi — faqat do'konlarda emas. Tungi cron har `(location_id, product_id)` juftligi uchun min/max ni qayta hisoblaydi.

### D4. Sotuv va ombor ma'lumotlari manbai — Poster POS integratsiyasi
MVP'da savdo **qo'lda kiritilmaydi**. ADIA ERP **Poster POS platformasiga integratsiya qilinadi** — dastur ham, AI assistant ham.
- Poster akkaunti: `adia` (joinposter.com). API qo'llanma: `docs/adia-poster-api.md`. Maxfiy kalitlar: `.env` (`POSTER_*`).
- Poster'da allaqachon **5 ta filial (spot)** va **25 ta ombor (storage)** bor — ADIA `locations` shularga moslanadi (mapping).
- Ostatka — `storage.getStorageLeftovers` dan; savdo/cheklar — `dash.getTransactions` va webhook'lardan (`transaction.close`) sinxronlanadi.
- ADIA ERP — Poster ustidagi **orkestratsiya / "miya" qatlami**: bo'g'inlararo replenishment, min/max engine, request state machine, ishlab chiqarish va AI dashboard. Poster — POS va ma'lumot manbai.

### D5. Ta'minot so'rovlari — ikki bosqichli tasdiq
Xom-ashyo yoki tovar yetmaganda yaratiladigan buyurtma **"Yetkazib berishga so'rov"** (supply request) sifatida boshliqqa ko'rinadi. Har bir so'rov **boshliq (manager) va skladchi (ombor menejeri) — ikkalasi tasdiqlagandan keyin** kuchga kiradi. (TZ dagi `purchase_order` shu ikki-bosqichli tasdiq oqimiga aylanadi.)

### D6. Har bo'g'inning o'z boshlig'i
Zanjirning **har bir bo'g'inida (location) o'z boshlig'i (manager)** bo'ladi — bo'g'in shu rol orqali ishlaydi. RBAC: har `location` ga kamida bitta manager-foydalanuvchi biriktiriladi; manager faqat o'z bo'g'inini boshqaradi.

---

## Ta'siri va hali aniqlanishi kerak bo'lgan nuqtalar

- **D4 (Poster)** — eng katta arxitektura ta'siri. `system-architect` aniqlashi kerak: Poster (spots / storages / ingredients / transactions) va ADIA (`locations` / `products` / `stock` / `sales`) o'rtasidagi mapping; sinxronlash strategiyasi (webhook + davriy poll); Poster `limit_value` bilan ADIA `min_level` munosabati.
- **D5** — yetkazib beruvchilar (supplier) ro'yxati MVP'da soddaroq bo'lishi mumkin; asosiy talab — ikki bosqichli tasdiq oqimi va boshliqqa ko'rinish.
- **Keyingi qadam:** `system-architect` shu qarorlar asosida Faza-1 (MVP) spec va DB sxemasini tayyorlaydi → reja egaga tasdiqlashga yuboriladi.
