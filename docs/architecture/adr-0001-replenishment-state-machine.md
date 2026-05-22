# ADR-0001 — Replenishment Request State Machine dizayni

- Status: Qabul qilingan (taklif — egaga tasdiqlashga)
- Sana: 2026-05-22
- Muallif: system-architect
- Bog'liq: TZ §8.2, `docs/specs/phase-1-mvp.md` §3

## Kontekst

ADIA ERP ning markaziy modeli — replenishment request. Ostatka min'dan tushganda
yaratiladi va zanjir bo'ylab (sklad → xom-ashyo → ishlab chiqarish → qaytarib jo'natish)
yuradi. TZ §8.2 holatlar ketma-ketligini belgilaydi. Bizga shu jarayonni ishonchli,
auditlanadigan, dublikatsiz boshqaradigan dizayn kerak.

Talablar:
- Invariant 2: bitta `(product, location)` uchun bitta ochiq request.
- Har o'tish auditlanadi (TZ §13).
- Cron worker ham, foydalanuvchi ham jarayonni surishi mumkin.
- "Kutuv" bosqichlari bor (purchase order tasdig'i, ishlab chiqarish tugashi) — jarayon
  ularda to'xtab turadi.

## Qaror

### 1. Holat enum DB darajasida
`replenishment_status` — PostgreSQL `ENUM`. Holatlar: `NEW`, `CHECK_STORE_SUPPLIER`,
`SHIP_TO_REQUESTER`, `CHECK_PRODUCTION_INPUT`, `CREATE_PURCHASE_ORDER`,
`CREATE_PRODUCTION_ORDER`, `PRODUCING`, `DONE_TO_WAREHOUSE`, `CLOSED`, `CANCELLED`.
Terminal: `CLOSED`, `CANCELLED`.

### 2. "Bitta ochiq request" — partial UNIQUE index
```sql
CREATE UNIQUE INDEX uq_replenishment_one_open
  ON replenishment_requests(product_id, requester_location_id)
  WHERE status NOT IN ('CLOSED','CANCELLED');
```
Bu invariant 2 ni **DB darajasida** kafolatlaydi — ilova logikasidagi xato ham dublikat
yarata olmaydi. Debounce ilovada emas, indeksda.

### 3. O'tishlar — ilova qatlamida aniq jadval (transition table)
State machine logikasi backend xizmatida `Map<from_status, allowed_to[]>` sifatida
kodlanadi. Har `advance` chaqiruvi:
1. Joriy holatni `SELECT ... FOR UPDATE` bilan bloklab oladi.
2. Guard funksiyasini tekshiradi (masalan, `central_wh.stock.qty >= qty_needed`).
3. Guard bajarilsa — yangi holat, bog'liq hujjat, stock movement, audit — **bitta
   tranzaksiyada**.
4. `replenishment_transitions` ga yozuv qo'shadi.
DB darajasida CHECK trigger emas, ilova darajasida — chunki o'tishlar tashqi holatga
(stock, production_order) bog'liq va biznes logika talab qiladi.

### 4. Auditlash — alohida `replenishment_transitions` jadvali
Har o'tish `(from_status, to_status, reason, actor_user_id, created_at)` bilan yoziladi.
`actor_user_id IS NULL` — cron/tizim. Bu request ning to'liq tarixini beradi.

### 5. "Kutuv" holatlari no-op `advance`
`CREATE_PURCHASE_ORDER` va `PRODUCING` — tashqi hodisani kutadi. Bu holatlarda `advance`
guard bajarilmagan bo'lsa xatosiz "hali tayyor emas" qaytaradi. Jarayonni `purchase_order`
`received` yoki `production_order` `done` bo'lganda o'sha modul `advance` ni chaqiradi.

### 6. Idempotentlik va parallellik
- `advance` `FOR UPDATE` lock orqali bir requestga parallel ikki chaqiruvni serializatsiya qiladi.
- Bir holatda ikki marta `advance` chaqirilsa — guard ikkinchi marta o'tmaydi yoki holat
  allaqachon o'zgargani uchun no-op.
- Cron har 5 daqiqada ochiq requestlarni `advance` qiladi — bu "kutuv" holatlaridan
  avtomatik chiqishni ta'minlaydi.

## Muqobillar

- **DB trigger bilan state machine:** rad etildi — guard'lar tashqi jadvallarga va biznes
  qoidalariga bog'liq, trigger ichida buni saqlash qiyin va testlash og'ir.
- **Status maydonisiz, faqat hujjatlar holatidan hisoblash:** rad etildi — "bitta ochiq
  request" invariantini indeks bilan kafolatlash imkonsiz bo'lardi.
- **BullMQ workflow:** Faza-1 uchun ortiqcha; node-cron + `advance` xizmati yetarli.
  Faza-2 da hajm oshsa qayta ko'rib chiqiladi.

## Oqibatlar

- (+) Invariant 2 DB darajasida kafolatlanadi.
- (+) To'liq audit trail; har request qayta tiklanadigan tarixga ega.
- (+) Cron va foydalanuvchi bir xil `advance` yo'lidan yuradi.
- (−) O'tish jadvali ilovada — DB sxema va kod sinxron bo'lishi kerak.
- Bog'liqlik: state machine ning `NEW → CHECK_STORE_SUPPLIER` qadami `locations.parent_id`
  topologiyasiga muhtoj. Bu topologiya — egasi seed vaqtida beradigan konfiguratsiya
  (spec §8.2 Shablon B), ochiq arxitektura savoli emas; sxema `parent_id` ustuni
  bilan tayyor.
