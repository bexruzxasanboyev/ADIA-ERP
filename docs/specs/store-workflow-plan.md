# Do'kon (Store) Ish-jarayoni — to'liq plan

> Manba: egasi spec (2026-06-05) + screenshot ("To'ldirish so'rovlari" tartibsiz).
> Maqsad: Do'kon uchun **toza, fokuslangan** sahifa — faqat kerakli narsalar.

## Egasi spec (qisqacha)
1. **Mahsulotlar Card** — do'kondagi mahsulotlar; filter: min'dan past / kam / tugagan / yetarli.
2. **So'rovlar** — ro'yxat + **"+ Add"**:
   - AI min'dan past mahsulotlarga **avto-so'rov** chiqaradi → **boshliq tasdiqlaydi** → so'rov ketadi.
   - "+ Add" → mahsulot tanlash (custom select) → pastga qo'shilib **jadval**да ko'rinadi → har biriga **soni** kiritiladi → tasdiqlasa omborда ko'rinadi.
3. **So'rovlar 2  taba:** **So'rov** (yuboruvchi) + **Qabul qiluvchi**.
4. **So'rov statusi:** Markaziy ombor **qabul qildi / qilmadi** — to'g'ri connection.
5. **Qabul qilish:** Markaziy ombor mahsulot yuborsa → do'kon qabul qiladi → **nechta** + **mahsulot turi** + **brak (yaroqsiz)** + **brak izohi** kiritadi → tasdiqlasa qabul qiladi.
6. Qabul qilingach **mahsulot count'lari Posterга ham qo'shilishi** kerak. ⚠️ (read-only qarorга zid — pastда savol)

---

## Hozir BOR (poydevor — qayta ishlatamiz)
- **Replenishment engine** store→central→production'ni allaqachon qiladi: `NEW → CHECK_STORE_SUPPLIER` (markaziy stockni tekshiradi) → yetsa `SHIP_TO_REQUESTER` (do'konга), yetmasa `CHECK_PRODUCTION_INPUT` → ishlab chiqarish. (`services/replenishment.ts`)
- Manual create: `POST /api/replenishment` — lekin **faqat central_warehouse_manager** (do'kon uchun ochish kerak).
- `RequestActionDialog` — accept_full / accept_partial / reject / return (qabul qilish qisman bor).
- `scanBelowMin` — min'dan past skan (AI avto-so'rov uchun asos).
- Stock movements atomar; audit; notifications.

## GAP (yangi quriladi)
- Do'kon-scoped toza sahifa (Mahsulotlar Card + stock-status filter).
- Do'kon o'zi so'rov yarata olishi (RBAC + UI).
- "+Add" ko'p-mahsulot custom so'rov (jadval + sonlar).
- AI avto-so'rov + boshliq tasdiq (pending-approval holati).
- So'rov / Qabul qiluvchi 2-tab.
- Qabul qilishда **brak (yaroqsiz) + izoh**.
- Poster count push (write-back) — qaror kerak.

---

## Reja (to'lqinlar — parallel)

### Wave 1 — Do'kon sahifasi (toza)
- **D1** (frontend + backend): Do'kon sahifasi — **Mahsulotlar Card** + stock-status filter (min'dan past/kam/tugagan/yetarli). Backend: do'kon stock + status. → `frontend-engineer` + `backend-engineer`.
- **D2** (frontend): hozirgi tartibsiz 398-so'rov ro'yxatини do'konга scoped, fokuslangan qilish.

### Wave 2 — So'rov tab (yuboruvchi)
- **S1** (backend): do'kon (store_manager) so'rov yaratishini yoqish (authorize + requester=do'kon).
- **S2** (frontend + backend): **"+Add"** ko'p-mahsulot so'rov — custom select → jadval → sonlar → tasdiqlash (batch create).
- **S3** (backend AI + frontend): AI avto-so'rov (min'dan past skan → taklif) → **boshliq tasdiqlaydi** → so'rov ketadi. Yangi `proposed`/`pending_approval` holati.

### Wave 3 — Status + connection (markaziy taraf)
- **C1** (backend + frontend): Markaziy ombor do'kon so'rovini ko'radi → **qabul/rad** (connection). Engine CHECK_STORE_SUPPLIER stockni tekshiradi; accept/ship'ni markaziy menejerга ochish.
- **C2** (frontend): so'rov statusi: So'ralgan → Markaziy qabul qildi → Jo'natildi → Qabul qilindi / Rad etildi / Ishlab chiqarishга.

### Wave 4 — Qabul qiluvchi + brak + Poster
- **R1** (frontend): **Qabul qiluvchi** tab — markaziydан kelgan jo'natmalar.
- **R2** (backend + frontend): qabul dialogi — qabul qilingan **soni** + **brak (yaroqsiz) soni** + **izoh** → tasdiqlash. `RequestActionDialog` ni kengaytirish.
- **R3** (backend): qabul qilinganда stock yangilanadi (do'kon +qabul, brak alohida) + audit.
- **R4** (backend): **Poster count push** (write-back) — agar egasi tasdiqlasa. ⚠️

---

## Ochiq savol (egasiga — qaror)
- **Poster write-back:** Avval siz **Poster read-only** dedingiz (Q7). Endi qabul qilingan count'larni Posterга qo'shishni xohlaysiz. Tasdiqlang:
  - **(a)** Posterга qaytarib yozamiz (`createSupply`/`createMovement` — Poster ombor qoldig'i yangilanadi), yoki
  - **(b)** Faqat ADIA ichida (count'lar bizда; Poster faqat manba).
- **AI avto-so'rov:** har do'kon uchun min'dan past mahsulotга 1 so'rov; boshliq bittadan tasdiqlaydimi yoki "hammasini tasdiqlash" tugmasi bilanmi?
