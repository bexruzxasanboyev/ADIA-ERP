# ADR-0001 — Replenishment Request State Machine dizayni

- Status: Qabul qilingan (Sprint 2 auditidan keyin aniqlangan, 2026-05-23)
- Sana: 2026-05-22 (Sprint 2 aniqliklari: 2026-05-23)
- Muallif: system-architect
- Bog'liq: TZ §8.2, `docs/specs/phase-1-mvp.md` §3, `apps/api/src/services/replenishment.ts`

## Versiya tarixi
- **2026-05-22 (v1):** Dastlabki dizayn — 10 holat, partial UNIQUE indeks, ilova qatlamida transition jadval, `advance` bitta tranzaksiyada, kutuv holatlari no-op.
- **2026-05-23 (v2 — Sprint 2 audit aniqliklari):** Quyidagi 6 nuqta aniqlandi (§Decision §7–§12).
  Bu yangilanish v1 ni o'zgartiradi (supersede emas); asosiy qarorlar (1–6) o'zgarmagan.

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

### 7. Branch (b)/(c) — xom-ashyo `raw_warehouse → production` transferi

**Muammo (Sprint 2 audit).** Branch (c) (xom-ashyo yetmaydi → `purchase_order` → `received` → `CREATE_PRODUCTION_ORDER`) oqimida purchase `applyMovement(reason='purchase')` xom-ashyoni `raw_warehouse` ga qo'shadi. Lekin `production_order` "tayyor" (`done`) bo'lganda BOM iste'mol harakati `production_orders.location_id` (ya'ni `production` location) dagi qoldiqdan qilinadi. `production` location'da xom-ashyo yo'q — natijada `409 INSUFFICIENT_STOCK` va butun zanjir uziladi. Branch (b) (xom-ashyo darhol yetarli) ham xuddi shu nuqsondan aziyat chekadi — `raw_warehouse` da yetarli bo'lsa-da, `production` da emas.

**Qaror.** `CHECK_PRODUCTION_INPUT → CREATE_PRODUCTION_ORDER` o'tishining **action**'iga xom-ashyoni `raw_warehouse → production` ga `applyMovement(reason='transfer')` bilan ko'chirish qadami qo'shiladi:
- Har BOM komponenti uchun kerakli miqdor (`qty_per_unit * qty_needed`) `raw_warehouse → production` location'ga atomar transfer qilinadi (bitta `withTransaction` ichida, `production_order` insert'i bilan birga).
- Bu branch (b) (darhol yetarli) va branch (c) (PO `received` dan keyin) ikkalasiga ham tegishli — chunki ikkalasida ham xom-ashyo `raw_warehouse` da turadi va undan iste'mol kerak.
- Transfer harakati `stock_movement(reason='transfer', replenishment_id=<id>)` sifatida yoziladi — to'liq auditlanadi.
- Agar transfer chog'ida `INSUFFICIENT_STOCK` yuzaga kelsa (masalan, sync ichida xom-ashyo allaqachon yo'qolib qolgan bo'lsa) — tranzaksiya butunlay rollback bo'ladi, state machine `CHECK_PRODUCTION_INPUT` da qoladi; keyingi `advance` da shortage sifatida ko'rinib, PO yaratiladi (branch (c)).

**Oqibatlar.**
- (+) Branch (b)/(c) ikkalasi to'g'ri yopiladi — production'da xom-ashyo bor, "tayyor" oqimi muvaffaqiyatli bajariladi.
- (+) Atomar — bitta tranzaksiyada PO + transfer; yarim holat yo'q.
- (−) `production_order` yaratilmaguncha xom-ashyo `raw_warehouse` da ko'rinib turadi; transferdan keyin `production` da — bu kutilgan xatti-harakat, lekin operatorlar uchun qo'shimcha movement satrlari paydo bo'ladi (har komponent uchun bittadan).
- Bog'liqlik: BOM qatori bo'sh bo'lmasligi kerak (recipe mavjud bo'lishi shart) — buni `advanceCheckProductionInput` allaqachon `bom.length === 0` ni `held` deb tekshiradi.

### 8. Skip-state semantics — bir `advance` bir necha o'tishni zanjir qilishi mumkin

**Muammo.** Foydalanuvchi `PATCH /api/production-orders/:id` orqali `new → done` ga to'g'ridan-to'g'ri o'tishi mumkin (`in_progress` ni o'tkazib yuborgan holda — bu spec §2.5 da ruxsat etilgan, AC5.1 faqat `done` ga o'tishni talab qiladi). Lekin bog'liq replenishment request `CREATE_PRODUCTION_ORDER` holatida turibdi va to'g'ridan-to'g'ri `DONE_TO_WAREHOUSE` ga sakray olmaydi — `ALLOWED_TRANSITIONS` da bunday qator yo'q (SM-2).

**Qaror.** `advance()` chaqiruvi **ichki zanjirlash** semantikasiga ega bo'ladi: bir `advance` chog'ida agar bir o'tishdan keyin **darhol** keyingi o'tish shartlari (guard) qondirilgan bo'lsa, state machine **bitta tranzaksiya ichida** keyingi qadamga ham o'tadi. Aniqrog'i:
- `CREATE_PRODUCTION_ORDER → PRODUCING` — guard `production_order.status IN ('in_progress','done')` (joriy kod allaqachon ikkalasiga ruxsat beradi).
- O'sha tranzaksiya ichida `production_order.status='done'` aniqlangan bo'lsa, `PRODUCING → DONE_TO_WAREHOUSE` ham darhol bajariladi (audit'da ikkala o'tish — alohida `replenishment_transitions` qatorlari).
- Zanjirlash faqat **kutilgan to'g'ri yo'l bo'yicha** (forward, ALLOWED_TRANSITIONS bo'yicha) ishlaydi — sakrash yo'q, faqat ketma-ket o'tishlar siqib bajariladi.
- Implementatsiya: `advance` ichida holatni o'zgartirgandan keyin, agar yangi holat **darhol** keyingi qadamga tayyor bo'lsa (guard bajariladi), tail-recursion / loop bilan davom etadi. Maks. 1 dona zanjir uzunligi cheklanadi (`CREATE_PRODUCTION_ORDER → PRODUCING → DONE_TO_WAREHOUSE`).

**Oqibatlar.**
- (+) `new → done` foydalanuvchi sakrashi to'g'ri ishlanadi; bog'liq request `CREATE_PRODUCTION_ORDER` da qotmaydi.
- (+) Audit jurnali to'liq — har bir mantiqiy o'tish alohida `replenishment_transitions` qatori.
- (+) SM-2 buzilmaydi — har qadam ALLOWED_TRANSITIONS bo'yicha tekshiriladi.
- (−) `advance` qaytuv qiymati `AdvanceResult` endi "oxirgi" holatni qaytaradi; chaqiruvchi har bir oraliq o'tishni alohida ko'ra olmaydi (lekin `replenishment_transitions` orqali topa oladi).

### 9. `target_location_id` — har doim `central_warehouse`

**Muammo.** `DONE_TO_WAREHOUSE → SHIP_TO_REQUESTER` faza faqat `target` markaziy sklad bo'lganda mantiqli (markaziy sklad → so'rovchi chizig'i). `production_order.target_location_id` esa production output ketadigan joy — bu ham markaziy sklad bo'lishi kerak (production output u yerda yig'iladi). Joriy kodda `request.target_location_id` `parent_id` zanjiridan birinchi `central_warehouse` ga belgilanadi, lekin bu aniq spec'da qayd etilmagan.

**Qaror.**
- `replenishment_request.target_location_id` — **har doim** zanjirdagi birinchi `type='central_warehouse'` location'ga teng (`resolveTopology(...).centralWarehouseLocationId`). Joriy `advanceNew` da `parent_id` qabul qilinishi mahsulot uchun yetmaydi — agar so'rovchi `store` bo'lsa `parent_id` to'g'ridan-to'g'ri `central_warehouse` bo'ladi; lekin agar boshqa zanjir shakli bo'lsa (masalan, store → supply → central) `parent_id` `central_warehouse` ga tushmaydi. Shuning uchun `advanceNew` `parent_id` o'rniga `resolveTopology(...).centralWarehouseLocationId` ga belgilashi kerak.
- `production_order.target_location_id` — **har doim** `request.target_location_id` (ya'ni markaziy sklad). Joriy kodda `request.target_location_id ?? topology.centralWarehouseLocationId` fallback bor — fallback olib tashlanishi va `request.target_location_id` (NEW dan keyin doimo to'ldirilgan) ishlatilishi kerak.
- `central_warehouse` topilmasa (seed nuqsoni) — `advance` `held` qaytaradi, audit'ga "no central_warehouse in chain" yoziladi.

**Oqibatlar.**
- (+) Bir invariant qoidasi: target = central_warehouse, har joyda bir xil.
- (+) `SHIP_TO_REQUESTER` semantikasi aniq — markaziy sklad → so'rovchi.
- (+) Production output va keyingi ship faza bir xil `target_location_id` ga tayanadi.
- Bog'liqlik: seed topologiyasi (spec §8.2 Shablon B) har zanjirda `type='central_warehouse'` location'ni o'z ichiga olishi shart — bu qattiq talab.

### 10. `advance` HTTP status — 200 OK

**Muammo.** Spec §4.5 da `POST /api/replenishment/:id/advance` `201` qaytaradi deyilgan. Lekin amalda `advance` yangi resurs yaratmaydi — `replenishment_transitions` qatori — bu audit/jurnal yozuvi, mustaqil resurs emas. Endpoint mavjud requestni yangilaydi (status flip).

**Qaror.** `POST /api/replenishment/:id/advance` `200 OK` qaytaradi. Javob shakli:
```json
{
  "advanced": true,
  "status": "<new_status>",
  "reason": "<short reason>",
  "request": { ... full row ... }
}
```
- `advanced: false` (kutuv holati / guard qondirilmagan) ham `200 OK` qaytaradi — bu xato emas (SM-4).
- Faqat `404 NOT_FOUND` / `409 INVALID_TRANSITION` / `403 FORBIDDEN` / `422 VALIDATION_ERROR` kabi xatolar 2xx dan tashqari.

### 11. `production_order` `cancelled` holati

**Muammo.** Spec §4.6 `PATCH /api/production-orders/:id` da `status: in_progress | done` ko'rsatilgan, lekin DB sxemasidagi `production_order_status` enumda `cancelled` ham bor. Foydalanuvchi qachondir zayafkani bekor qilishi kerak bo'lishi mumkin (xato yaratilgan, talab o'zgargan).

**Qaror.**
- `PATCH /api/production-orders/:id` `status` maydonida qo'shimcha `cancelled` qiymatini qabul qiladi.
- Faqat `new` yoki `in_progress` holatdan `cancelled` ga o'tish ruxsat etiladi; `done → cancelled` taqiqlanadi (`409 INVALID_TRANSITION`) — chunki "tayyor" stock movement allaqachon qo'llanilgan.
- `cancelled` ga o'tganda bog'liq `replenishment_request` (agar bor bo'lsa) `CANCELLED` ga o'tkazilmaydi avtomatik — `pm` qo'lda hal qiladi (chunki yangi `production_order` yaratilishi kerak bo'lishi mumkin). Audit'ga "linked production_order cancelled" yoziladi.
- RBAC: `production_manager` (o'z `location_id` da) va `pm`.

### 12. Multi-shortage sekvensial PO oqimi — Faza-1 cheklovi

**Muammo.** Bir vaqtda bir nechta xom-ashyo komponenti yetmasa, joriy `advanceCheckProductionInput` faqat **birinchi** shortage uchun PO yaratadi va `request.purchase_order_id` ga yozadi. PO `received` bo'lib qaytib kelganda `advanceWaitingForPurchase` `advanceCheckProductionInput` ga qaytadi va keyingi shortage'ni topadi — yangi PO yaratadi va `purchase_order_id` ni **qayta yozadi**. Bu eski PO bilan request orasidagi bog'lanishni o'chiradi (qidirish/UI da yo'qoladi).

**Qaror (Faza-1 MVP).**
- Sekvensial yondashuv saqlanadi: har `advance` chog'ida bitta keyingi shortage uchun bitta PO. Bir vaqtda bir nechta PO yaratilmaydi.
- **Lekin** `request.purchase_order_id` qayta yozilmasin — `advanceCheckProductionInput` yangi PO yaratishdan **oldin** uni `NULL` ga tushiradi (agar oldingi PO `received` bo'lgan bo'lsa). Audit jurnali eski PO bilan bog'lanishni saqlaydi:
  - `replenishment_transitions.reason` ga oldingi PO ID kiritiladi (`"purchase_order #N received; raw component #M still short"`).
  - `audit_log` da `replenishment.purchase_order.unlink` yozuvi: `{ previous_purchase_order_id, reason }`.
- M:N bog'lanish jadvali (`replenishment_purchase_orders`) — **Faza-2** ga qoldirildi. Spec §8 da "Dead enum values to remove" bilan birga qayd etiladi.

**Oqibatlar.**
- (+) Audit jurnali har PO bilan bog'lanishni saqlaydi — yo'qolish yo'q.
- (+) Faza-1 minimal o'zgarish — sxema o'zgarmaydi.
- (−) UI da bitta requestning **barcha** PO'larini ko'rsatish uchun `audit_log` / `replenishment_transitions` dan yig'ish kerak; Faza-2 da M:N bilan to'g'ri ko'rinadi.

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

## Sprint 2 aniqliklarining qisqacha xulosasi (2026-05-23)

| # | Aniqlik | Ta'sir | Implementatsiya ko'lami |
|---|---|---|---|
| 7 | `raw_warehouse → production` transfer `CREATE_PRODUCTION_ORDER` action'ida | branch (b)/(c) ikkalasi | `replenishment.ts` `advanceCheckProductionInput` ichiga `applyMovement(transfer)` loop |
| 8 | Skip-state semantics — bir `advance` zanjir qiladi | `new → done` foydalanuvchi sakrashlari | `advance` ichida forward chain loop, har qadam alohida audit |
| 9 | `target_location_id` har doim `central_warehouse` | NEW va `production_order.target` mutanosib | `advanceNew` `parent_id` o'rniga `resolveTopology().centralWarehouseLocationId` |
| 10 | `advance` HTTP `200 OK`, javob `{advanced, status, reason, request}` | API kontrakt aniqligi | `apps/api/src/routes/replenishment.ts` (mavjud kod allaqachon shunday qaytaradi — spec'ni moslash) |
| 11 | `production_order → cancelled` ruxsat (faqat `new`/`in_progress` dan) | yangi PATCH qiymati | `production_orders.ts` service va spec §4.6 |
| 12 | Multi-shortage sekvensial; `purchase_order_id` qayta yozilmasin (NULL → yangi); M:N Faza-2 | audit yo'qolmaydi | `advanceCheckProductionInput` yangi PO'dan oldin `purchase_order_id = NULL` + audit `replenishment.purchase_order.unlink` |

Bu aniqliklar ADR-0001 ning asosiy 6 qaror'iga (§1–§6) qo'shimcha, ularni o'zgartirmaydi. Implementatsiyani team lead `backend-engineer` ga taqsimlaydi.
