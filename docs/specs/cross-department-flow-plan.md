# Bo'limlararo to'liq oqim — chuqurlashtirilgan plan (v2)

> ADIA ERP — bo'limlar (отдел / sex / sklad / do'kon) o'rtasidagi so'rovlar,
> ishlab chiqarish mantig'i, Kanban, if/else va fors-major holatlari.
> Egasi bilan 2026-06-09 muhokamasi + kodning chuqur verifikatsiyasi natijasi.
>
> **Holat:** logika/dizayn plani — kod yozilmagan; egasi "boshla" deganda
> implementatsiyaga o'tiladi.
>
> **v2 o'zgarishlari (v1 ga nisbatan):**
> 1. Kod qayta tekshirildi — v1'dagi 2 ta "qurish kerak" bandi XATO edi:
>    Q1/Q2 tasdiq dialogi (`productionDialog`, 0031) va sex-storage-first
>    iste'mol allaqachon BOR. Gap-jadval to'g'rilandi (§16).
> 2. Aniq data-model deltasi qo'shildi (§8): so'rovlar daraxti uchun ustunlar.
> 3. Rezervatsiya modeli loyihalandi (§7) — 2 variant, tavsiya bilan.
> 4. Kanban ↔ mavjud `pipeline_stage` ↔ eski 4-bucket kelishuvi (§9).
> 5. Tasdiq darvozalari mavjud mexanizmlarga bog'landi; yangi ochiq qarorlar
>    (§15: #8 #9 #10) ajratildi.
> 6. Bosqichli yo'l xarita (F-A…F-F) acceptance-criteria bilan (§17).
>
> Tekshirilgan manbalar: `replenishment.ts` (state machine, advance, scan),
> `crossDeptRequest.ts`, `productionDialog.ts`, `productionOrder.ts`, `bom.ts`,
> `purchaseOrder.ts`, `notify.ts`, `minmaxRecalcCron.ts`, migratsiyalar
> 0001/0024/0026/0029/0030/0031/0045/0052/0054/0055/0060, frontend
> `central/*`, `production/*`, `replenishment/statusBuckets.ts`.

---

## 0. Asosiy g'oya (bir jumlada)

Butun zanjir — **bitta o'zini-o'zi to'g'rilaydigan so'rov mexanizmi**: pastki
bo'g'in so'raydi → yuqori bo'g'in (yoki yon producer-sex) bajaradi → yetishmasa
o'zi keyingi so'rovni tug'diradi (**rekursiv daraxt**). Har bo'g'inda **bo'lim
boshlig'ining tasdig'i** — hech narsa odam ko'rmasdan o'tmaydi.

## 1. Tamoyillar

1. **Har bo'lim 2 doska:** 📥 *kelgan* (men ta'minotchi) + 📤 *chiqgan*
   (men mijoz). Bitta so'rov — ikki tomondan ko'rinadi; status yagona.
2. **Yagona Kanban grammatikasi** — hamma bo'limga bir xil 5 ustun.
3. **Boshliq tasdig'i har hopda** — qabul, з/г ishlatish, bufer to'ldirish,
   sub-so'rov.
4. **Reuse, not reinvent** — yangi mexanizm faqat mavjudini kengaytirsa
   qo'shiladi (state machine, crossDeptRequest, dialog, notify allaqachon bor).

---

## 2. Bo'limlar va rollari

| Bo'lim | `location_type` | Roli | Manba |
|---|---|---|---|
| Xom-ashyo ombori | `raw_warehouse` | Manba — barcha xom-ashyo | Poster «Основной склад» |
| Tort / Perojniy / YF sexi | `production` | Ishlab chiqarish | Poster Цех (0054) |
| **Qaymoq sexi** | `production` | **Faqat крем каймак** | **app-owned (0060)** |
| Tvorojniy va boshqa sexlar | `production` | O'z semi'sini yasaydi | Poster Цех |
| Har sexning skladi | `sex_storage` | з/г + tayyor bufer (parent = o'z sexi) | — |
| Markaziy Sklad | `central_warehouse` | Hub | Poster «Склад Центральный» (storage 8) |
| Do'konlar | `store` | Sotuv nuqtasi | Poster sklad |

Har bo'limning **o'z boshlig'i** bor (Invariant 6) — so'rovni faqat u qabul/rad
qiladi.

## 3. Bog'lanish — ikki "sim"

**(a) `locations.parent_id` — SO'ROV yo'nalishi (yuqoriga):**
```
Do'kon ─▶ Markaziy Sklad ─▶ Production ─▶ Xom-ashyo ombori
sex_storage ─▶ o'z sexi
```

**(b) `location_flows` — MAHSULOT oqimi (pastga/yon, M:N):**
`production_output` (sex→o'z skladi), `bom_input` (sklad→iste'molchi sex,
teskari halqa: YF/Qaymoq skladi→Tort/Perojniy), `forward` (har sklad→Markaz).

> `parent_id` = kim kimdan **so'raydi**; `location_flows` = kim kimga
> **jo'natadi**. Qarama-qarshi yo'nalish.

## 4. Routing — to'liq qaror daraxti

```
So'rov yaratilganda target (resolveRequestTarget):
│
├─ Mahsulot SEMI va workshop_location_id ≠ NULL?
│   └─ HA → PRODUCER OVERRIDE: target = o'sha sexning sex_storage'i
│           (eng kichik id'li bola; o'ziga route bo'lsa — skip)
│           target so'rovga PIN qilinadi (RBAC + accept bir joyga qarasin)
│
└─ YO'Q → DEFAULT: target = topologiya parent
    ├─ store           → central_warehouse
    ├─ central (kam)   → production
    ├─ sex (xom-ashyo) → raw_warehouse
    └─ raw_warehouse   → hech kim (root) → xarid = Poster Поставки
```

Engine ichida (CHECK_PRODUCTION_INPUT): production joy =
`products.workshop_location_id` (ustun) yoki topologiya production (fallback).

**Yaratish kanallari:** scan-cron (min'dan past, store'lar EMAS — ular
AI-propose→approve), web forma, Telegram ovoz/menyu (`crossDeptRequest`),
dialog emissiyasi (quyida), partial-fulfill shortfall.

## 5. Retsept modeli (tekshirilgan)

- `recipes`: product→component, `qty_per_unit`, `brutto/netto`, **`stage`**
  (`base` | `decoration` | `assembly`), `recipe_yield` bo'linadi.
- Komponent `raw` | `semi` | `finished`; `semi` rekursiv ochiladi
  (12 daraja cap, sikl himoyasi yozishda).
- `readFinalBom`: decoration bo'lsa — FAQAT decoration (hamir alohida
  zagatovka sub-order, ikki marta iste'mol R3 bug'idan himoya);
  legacy flat → hammasi.
- **Muhim fakt:** decoration'da BIR NECHTA semi bo'lishi mumkin (misol,
  mahsulot 2394: «крем каймак» + «з/г творожный»). Hozirgi
  `findZagatovkaComponent` esa `LIMIT 1` — faqat bittasini ko'radi (§16 gap).

## 6. Ishlab chiqarish — to'liq oqim

### 6.1 Ikki sikl

| Sikl | Trigger | Bugun kodda |
|---|---|---|
| **A — buyurtmaga** | so'rov keldi | advance + dialog (quyida) |
| **B — bufer** | з/г `qty ≤ min` (sex_storage) | scan avto-yaratadi (store emas); min/max dynamic cron bor (ADR-0007) |

### 6.2 Bugungi avto-oqim (engine, tekshirildi)

`CHECK_PRODUCTION_INPUT`da har BOM-liniya bo'yicha:
`sexTake = min(sexHave, need)` (o'z sex_storage'idan birinchi — ADR-0015),
`rawNeed = need − sexTake`. Yetishmasa → `CREATE_PURCHASE_ORDER` (bittadan,
self-loop, M:N PO jadvali). Hammasi yetsa → komponentlar production joyiga
ATOMAR transfer + production order. Store-requester so'rovlar avto-advance
qilinMAYdi — central accept darvozasi (acceptByCentral / xreq) majburiy.

### 6.3 Bugungi tasdiq dialogi (BOR! — `productionDialog`, 0031)

Tayyor tort ishlab chiqarishdan oldin AI ikki savol beradi (web modal + TG,
bitta servis):

- **Q1** `AWAITING_SOURCE_DECISION`: «N buyurtma, M zagatovka bor —
  **tayyordan yoki 0dan?**» → з/г ishlatish tasdig'i.
- **Q2** `AWAITING_CREAM_CONFIRM`: yetishmagan decoration komponent (krem/
  bezak) uchun: «**yangi tayyorlash yoki ombordan?**» (OQ5: semi+workshop →
  production so'rovi o'sha sexga; raw/«ombordan» → xarid so'rovi).

Yechilganda BITTA tranzaksiyada: zagatovka sub-order
(`stage_role='zagatovka'`, target = sex_storage) va/yoki yetishmaganlarga
replenishment so'rovlari. Muddati o'tsa — expire cron yopadi.

### 6.4 V2 kengaytmasi — N-komponentli rekursiv REZOLVER

Bugungi dialog 1 zagatovka + 1 krem savoliga mo'ljallangan. V2 uni
**umumlashtiradi** — «Boshlash» bosilganda boshliqga **bitta "Manba reja"
ekrani** chiqadi: decoration BOM'ning HAR liniyasi bo'yicha holat + qaror:

```
HAR komponent uchun (rekursiv):
├─ RAW
│   ├─ raw omborda bor → transfer (rezerv)
│   └─ yo'q → xarid so'rovi (PO, 2-bosqichli tasdiq)
└─ SEMI (producer = workshop_location_id):
    ├─ producer YO'Q (NULL) → shu sexda joyida yasaladi (zagatovka sub-order)
    ├─ producer = O'ZI:
    │   ├─ o'z skladida bor → "tayyordan" (tasdiq) → transfer
    │   └─ yo'q → zagatovka sub-order (0dan) → uning BOM'i REKURSIV
    └─ producer = BOSHQA sex (krem kaймак → Qaymoq):
        ├─ PRODUCER skladida bor → bom_input transfer (tasdiq)
        └─ yo'q → SUB-SO'ROV producer sexga (crossDeptRequest reuse,
                  parent link §8) → Qaymoq boshlig'i ✅/❌ → u o'zida
                  shu algoritmni qaytaradi (REKURSIYA)
```

Qarorlar bitta ekranda per-liniya: `[tayyordan] [0dan] [ombordan]`.
Tasdiqlangach hujjatlar bitta tranzaksiyada chiqadi; bor komponentlar
**rezerv** (§7), root so'rov bolalar tugaguncha kutadi (§8).

> Muhim farq bugungidan: semi mavjudligi endi O'Z sex_storage'ida emas,
> **producer'ning** sex_storage'ida tekshiriladi (krem uchun Qaymoq skladi).

### 6.5 Bezak qoidasi

Bezak/ukrasheniye (mastika, gul…) — `raw`, з/г bo'lmaydi → doim Homashyo.
(Bu §6.4'da RAW tarmoq orqali avtomatik qamrab olinadi.)

## 7. Rezervatsiya modeli (dizayn)

Muammo: krem kutilayotganda bor biskvitni boshqa buyurtma «yeb qo'ymasin».

| | **Variant A — transfer-as-reserve** (tavsiya) | Variant B — `component_reservations` jadvali |
|---|---|---|
| Mexanizm | Bor komponentlar darhol production joyiga **ko'chiriladi** (bugungi transfer mantig'i, faqat endi QISMAN ham mumkin) | Yangi jadval: `(order_id, location, product, qty, status)`; available = on-hand − faol rezervlar |
| Afzallik | `applyMovement` + ledger + audit REUSE; manfiy-stok himoyasi tayyor; fizikaga mos (komponent sexga olib kelindi) | Tovar joyida qoladi; bekorda qaytarish oson |
| Kamchilik | Bekor qilinsa teskari transfer kerak (compensating movement) | Yangi invariant qatlami: har availability o'qishda rezervni hisoblash — xato xavfi |
| Qaror | **A — MVP uchun** | B — keyinroq, agar A yetmasa |

Variant A qoidasi: «Manba reja» tasdiqlanganda bor qismlar transfer qilinadi
(movement `note='reserve'`), production order **bolalar tugaguncha**
yaratilmaydi yoki `new`da turadi; root bekor bo'lsa — teskari transferlar
shu tranzaksiyada qaytariladi.

## 8. So'rovlar daraxti — data-model delta

Bugun: `production_orders`da `parent_production_order_id` + `stage_role` BOR
(1 daraja); `replenishment_requests`da esa parent yo'q — dialog yaratgan
sub-so'rovlar root bilan BOG'LANMAGAN (Kanban daraxtni ko'rsata olmaydi,
root avto-davom eta olmaydi).

**Migratsiya (yangi):**
```sql
ALTER TABLE replenishment_requests
  ADD COLUMN parent_request_id BIGINT NULL REFERENCES replenishment_requests(id),
  ADD COLUMN root_request_id   BIGINT NULL REFERENCES replenishment_requests(id),
  ADD COLUMN depth             SMALLINT NOT NULL DEFAULT 0,  -- cap 12, BOM bilan bir xil
  ADD COLUMN origin            VARCHAR(16) NOT NULL DEFAULT 'manual';
  -- origin: scan|manual|voice|dialog|shortfall|buffer
CREATE INDEX ... ON replenishment_requests(root_request_id) WHERE root_request_id IS NOT NULL;

-- Invariant-2 to'qnashuvi uchun (bitta ochiq so'rovga bir nechta kutuvchi root):
CREATE TABLE request_waiters (
  child_request_id  BIGINT NOT NULL REFERENCES replenishment_requests(id),
  waiter_request_id BIGINT NOT NULL REFERENCES replenishment_requests(id),
  PRIMARY KEY (child_request_id, waiter_request_id)
);
```

**Qoidalar:**
- Sub-so'rov yaratish `createCrossDeptRequest` REUSE (producer override,
  debounce, notify hammasi tayyor) + parent/root/depth to'ldiriladi.
- **Invariant 2 bilan birga yashash:** o'sha producer'da o'sha mahsulotga
  ochiq so'rov BOR bo'lsa — yangisi ochilmaydi; mavjudiga `request_waiters`
  qatori qo'shiladi va (faqat hali accept QILINMAGAN bo'lsa) `qty_needed`
  yetishmagan miqdorga oshiriladi; accept bo'lgan bo'lsa — qty tegilmaydi,
  yetishmasa yopilgandan keyin follow-up ochiladi. *(siyosat — ochiq qaror #9)*
- **Daraxt tugashi:** bola `CLOSED` bo'lganda engine waiter-root'larni
  qayta-advance qiladi (cron 5-daqiqa baribir tekshiradi; parent-link bilan
  darhol chain).
- **Bekor qilish:** root bekor → boshqa waiter'i YO'Q bolalar avto-bekor;
  waiter'i borlar qoladi. *(kaskad siyosati — ochiq qaror #10)*

## 9. Kanban spetsifikatsiyasi

### 9.1 Kanonik 5 ustun ↔ mavjud `pipeline_stage`

| Kanonik (egasi) | `pipeline_stage` (0058, kodda BOR) | Texnik statuslar |
|---|---|---|
| Kutuvda | `kutuvda` | NEW, CHECK_STORE_SUPPLIER; manual DONE_TO_WAREHOUSE |
| Tasdiqlandi / Tayyorlanmoqda | `soralgan` | CHECK_PRODUCTION_INPUT…PRODUCING, avto DONE_TO_WAREHOUSE |
| Tayyor | `qabul_qilingan` | SHIP_TO_REQUESTER |
| Jo'natildi (rezerv) | `yuborilgan` | CLOSED + closure_reason IS NULL |
| Yopildi | `yopilgan` | CANCELLED; CLOSED + closure_reason |

Yon holatlar — `closure_reason` badge'lari: `accepted_full/partial`,
`rejected`, `returned`, `cancelled_*` + brak maydonlari.

> **Birlashtirish:** eski 4-bucket (`statusBuckets.ts`: all/pending/sent/
> closed) bekor qilinib, hamma joyda `pipeline_stage` ishlatiladi —
> bitta grammatika (server allaqachon hisoblaydi, N+1 yo'q).

### 9.2 Har bo'lim doskalari (2 tadan)

| Bo'lim | 📥 Kelgan (filtr: target = men) | 📤 Chiqgan (filtr: requester = men) |
|---|---|---|
| Do'kon | — (yo'q) | 5 ustun to'liq |
| Markaziy | do'kon so'rovlari (5 ustun + fulfill/partial) | production'ga so'rovlari |
| Sex | markaz + boshqa sexlardan (krem!) | homashyo + producer-sexlarga |
| Homashyo | sexlardan | — (xarid = PO bo'limi + Poster) |

UI joylashuvi: `CentralWorkflowPage` / `ProductionWorkflowPage` allaqachon
shu naqshda (dashboard + so'rovlar tablari) — v2 ularni 5-ustun + 2-doska
ko'rinishiga keltiradi; so'rov detalida **daraxt ko'rinishi**
(root→bolalar, har bolaning stage'i, `TransitionTimeline` reuse).

## 10. Tasdiq darvozalari + RBAC (mavjudga bog'langan)

| Darvoza | Mexanizm | Holat |
|---|---|---|
| Do'kon so'rovini markaz qabul/rad | acceptByCentral + `xreq:*` inline | ✅ BOR (avto-advance store'ni o'tkazib yuboradi) |
| Pinned-target so'rov (krem→Qaymoq) qabul | acceptByFulfiller + xreq | ✅ BOR |
| з/г «tayyordan/0dan» | dialog Q1 | ✅ BOR |
| Yetishmagan krem «yasash/ombordan» | dialog Q2 | ✅ BOR (1 komponent; v2: N-liniya reja §6.4) |
| Xarid 2-bosqichli (boshliq+skladchi) | purchaseOrder draft→approved | ✅ BOR |
| **Sex/raw'ga kelgan ICHKI so'rovlar gate'i** | bugun avto-advance | ⚠️ QURISH — ochiq qaror #8 |
| **Bufer (B-sikl) tasdig'i** | scan NEW yaratadi; gate #8 qo'shilsa = «tavsiya kartasi» bo'lib qoladi | ⚠️ #8 bilan birga hal |

RBAC: har doskada tugmalar faqat o'sha location operator/manager'iga
(requireLocationOperator naqshi); PM/Admin butun zanjirni ko'radi.

## 11. Notifikatsiya matritsasi (notify.ts + TG outbox — BOR)

| Hodisa | Qabul qiluvchi | Kanal |
|---|---|---|
| So'rov yaratildi | requester manager + target manager | web + TG (inline ✅/❌) |
| Qabul/rad/qaytarildi | requester manager | web + TG |
| min'dan past (`stock_below_min`) | location manager (24h dedupe) | web + TG |
| Jo'natildi / yetib keldi | qabul qiluvchi boshliq | web + TG |
| Sub-daraxt tugadi → root davom | root requester boshlig'i | **YANGI** |
| Dialog kutmoqda / muddati o'tdi | sex boshlig'i | ✅ BOR (expire cron) |

## 12. з/г bufer (B-sikl) detali

- min/max har `(location, product)`da `stock` jadvalida; `minmax_mode='dynamic'`
  bo'lsa kunlik cron: `min = avg×lead_time×safety`, `max = min + avg×review`
  (ADR-0007) — з/г buferlar ham shu formulada.
- Scan sex_storage'larni QAMRAYDI (faqat store chiqarilgan) → krem min'dan
  tushsa avto so'rov ochiladi; #8 gate bilan u Qaymoq doskasida «Kutuvda»
  tavsiya-karta bo'lib turadi → boshliq ✅ → ishlab chiqarish.
- `products.shelf_life` (0023) bor — keyingi faza: buferda FEFO/muddati
  ogohlantirishi.

## 13. Fors-major katalogi

**Routing/yaratish:** target yo'q (root so'radi) → validation xato ·
dublikat → OPEN_REQUEST_EXISTS → waiter-link (§8) · o'ziga-route → parent
fallback · BOM yo'q → hold (`advanced:false`, sabab ko'rinadi).

**Bog'liqlik:** producer sklad bo'sh → sub-so'rov zanjiri (tasdiq bilan) ·
producer'da HAM yo'q → rekursiya davom (depth cap 12) · retsept sikli →
yozishda rad + cap · ikki root bitta bolaga → waiters + qty siyosati (#9).

**Bajarish:** qisman jo'natma → fulfill: bor qismi ketadi, shortfall yangi
so'rov (batch_id) · brak har qabulda (cap: `received+brak ≤ shipped`, 422) ·
qaytarish → closure_reason + teskari movement · ishlab chiqarishda komponent
yetmay qoldi → INSUFFICIENT_STOCK, BUTUN tranzaksiya rollback.

**Odam:** boshliq javob bermaydi → so'rov Kutuvda turadi; dialog muddati →
expire cron; (keyingi faza: SLA eslatma) · ikki manager bir vaqtda bosdi →
FOR UPDATE + idempotent (ikkinchisiga «allaqachon») · noto'g'ri qabul →
return oqimi.

**Integratsiya/data:** Poster uzildi → lokal oqim to'xtamaydi (writeback
best-effort, queue, dry-run default) · ikki marta accept → unique
`(request, product, direction)` — double-decrement yo'q · ostatka manfiy
bo'lishi mumkin emas (DB CHECK + applyMovement guard) · stock drift →
posterStockSync + inventarizatsiya (0063).

## 14. Poster mapping (qulflangan)

| Bizda | Poster |
|---|---|
| Homashyo ombori | «Основной склад» |
| Markaziy Sklad | «Склад Центральный» (storage 8) |
| з/г katalogi | «Полуфабрикаты» |
| Producer-sex | mahsulot «Цех»i → `workshop_location_id` (0054); крем каймак — app-owned (0060) |
| Homashyo to'ldirilishi | «Поставки», **FAQAT `Склад=Основной склад`** qatorlari |
| Markaz→do'kon yakuni | central decrement writeback (gated, dry-run default) |

Homashyo→ta'minotchi xaridi Poster'da qoladi; bizda `stock_below_min`
signal (BOR) + «Xarid signallari» ko'rinishi (§17 F-F).

## 15. Qarorlar

**Tasdiqlangan (qayta ochilmaydi):**
1. Yagona 5-ustunli Kanban grammatikasi, har bo'limda 2 doska.
2. Har hopda boshliq tasdig'i.
3. з/г ishlatish — tasdiq bilan (dialog Q1 — bor).
4. Bufer to'ldirish — tavsiya → tasdiq.
5. Bog'liqlik yetishmasa — B-variant: zanjir sub-so'rov + tasdiq; root
   rezerv bilan kutadi.
6. Producer = `workshop_location_id` (Poster Цех); faqat крем каймак
   app-owned → Qaymoq sexi. Nomga emas — ustunga qaraladi.
7. Homashyo «xarid kerak» = signal/ogohlantirish (Poster read-only qoladi).

**Yangi ochiq qarorlar (egasiga):**
8. **Ichki gate qamrovi:** sex/raw'ga kelgan ICHKI so'rovlar ham qabul
   darvozasidan o'tsinmi (bugun avto)? *Tavsiya: HA — acceptByFulfiller +
   xreq reuse; avto-advance skip-ro'yxati kengayadi (kichik o'zgarish).*
9. **Qty-top-up siyosati:** mavjud ochiq bolaga ikkinchi root qo'shilganda
   miqdor oshirilsinmi (faqat accept'dan OLDIN)? *Tavsiya: HA, accept'dan
   keyin — follow-up so'rov.*
10. **Bekor kaskadi:** root bekor bo'lsa, boshqa kutuvchisi yo'q bolalar
    avto-bekormi? *Tavsiya: HA, sabab bilan; tasdiqsiz.*

## 16. Gap-analiz (v1 XATOLARI TO'G'RILANGAN)

| Komponent | v1 bahosi | v2 fakt |
|---|---|---|
| Topologiya, state machine, pipeline_stage, partial fulfill, brak cap, batch | ✅ bor | ✅ tasdiqlandi |
| crossDeptRequest + producer override + xreq inline | ✅ bor | ✅ tasdiqlandi |
| з/г «ishlatamizmi?» darvozasi | ⚠️ qurish | **✅ BOR** — dialog Q1/Q2 (0031, web+TG, expire cron) |
| Sex-storage-first iste'mol | aytilmagan | **✅ BOR** — advanceCheckProductionInput per-line |
| Zagatovka sub-order daraxti | ⚠️ qurish | **✅ BOR (1 daraja)** — `parent_production_order_id`, `stage_role` (0030) |
| Bufer avto-so'rov (B-sikl) | ⚠️ qurish | **✅ YARIM** — scan sex_storage'ni qamraydi; tasdiq-gate yo'q (#8) |
| **N-semi «Manba reja»** (findZagatovka LIMIT 1 → umumlashtirish) | — | ⚠️ QURISH (§6.4) |
| **Producer skladidan availability + bom_input transfer** | — | ⚠️ QURISH (hozir faqat O'Z sex_storage o'qiladi) |
| **Request-daraxt linklari** (parent/root/depth/waiters) | ⚠️ | ⚠️ QURISH (§8) — production_orders'da bor, requests'da YO'Q |
| **Qisman rezerv (transfer-as-reserve) + root kutishi** | ⚠️ | ⚠️ QURISH (§7) — bugun all-or-nothing |
| **Ichki accept-gate (sex/raw)** | — | ⚠️ QURISH (#8) |
| **Kanban birlashtirish** (4-bucket → pipeline_stage, 2-doska, daraxt-ko'rinish) | ⚠️ | ⚠️ QURISH (§9) |
| Xarid signallari ko'rinishi | ⚠️ | ⚠️ QURISH (notif BOR, UI sahifa yo'q) |

## 17. Bosqichli yo'l xarita

| Faza | Mazmun | Acceptance |
|---|---|---|
| **F-A. Sxema** | Migratsiya: parent/root/depth/origin + request_waiters (§8). Hech bir mavjud oqim o'zgarmaydi. | Migratsiya idempotent; eski testlar yashil; yangi ustunlar NULL-safe |
| **F-B. Rezolver v2** | «Manba reja» servisi: N-liniya tahlil (producer-aware availability), per-liniya qaror, hujjatlar bitta tranzaksiyada (transfer-rezerv / zagatovka / sub-so'rov / PO), dialog Q1/Q2'ni umumlashtirish | 2394-tipidagi multi-semi retsept to'g'ri rejalashadi; krem so'rovi Qaymoqqa parent-link bilan tushadi; rollback butun |
| **F-C. Gate'lar** | #8: ichki so'rovlar accept-gate (skip-list kengayadi, acceptByFulfiller reuse); bufer kartalari shu bilan «tavsiya» bo'ladi | Sex/raw doskasida Kutuvda→✅/❌ ishlaydi; avto-advance gate'ni chetlab o'tmaydi |
| **F-D. Daraxt yakuni** | Bola CLOSED → waiter-root avto-advance + notify; bekor kaskadi (#10); qty-top-up (#9) | Napoleon stsenariysi (§18a) E2E o'tadi |
| **F-E. Kanban UI** | 5-ustun + 2-doska hamma workspace'larda; statusBuckets → pipeline_stage; so'rov detalida daraxt; rezerv/progress badge'lar | Har rol o'z 2 doskasini ko'radi; bitta so'rov ikki doskada bir stage'da |
| **F-F. Signal/polish** | «Xarid signallari» sahifasi (below-min → karta), SLA eslatma cron, FEFO hint | Homashyo boshlig'i signaldan PO draft ocha oladi |

Tartib qat'iy: F-A → F-B → F-C/F-D (parallel mumkin) → F-E → F-F.
Har faza kichik, atomar commit'lar bilan; har biri alohida ko'rsatiladi
(per-feature feedback loop).

## 18. End-to-end misollar

**(a) Napoleon — multi-semi, krem yo'q.** Kukcha 10 ta Napoleon so'raydi →
markaz: yo'q → Tort sexiga (gate) → boshliq «Boshlash» → Manba reja:
biskvit(semi, o'zi) BOR→rezerv-transfer; крем каймак(semi, producer=Qaymoq)
YO'Q→sub-so'rov Qaymoqqa (parent=root); bezak(raw) → homashyodan transfer.
Qaymoq boshlig'i ✅ → krem retsepti (каймок/шакар/ванилин raw bor) →
ishlab chiqaradi → Qaymoq skladi → bom_input transfer Tort sexiga →
bola CLOSED → root avto-davom → production order → tayyor → sex skladi →
markaz → do'kon (rezerv) → do'kon qabul (brak=0) → yopildi.
Daraxt: 1 root + 1 sub-so'rov + 2 transfer + 1 PO-yo'q.

**(b) B-sikl bufer.** Qaymoq skladida krem `qty ≤ min` → scan avto so'rov
(origin='buffer') → Qaymoq doskasi «Kutuvda» tavsiya-karta → boshliq ✅ →
ishlab chiqarish → bufer `max`gacha to'ldi → yopildi. Do'kon/sex bu paytda
hech narsa kutmagan — zaxira oldindan tayyor.

**(c) Qisman + brak.** Do'kon 30 so'radi, markazda 18 → fulfill: 18 ketdi
(CLOSED/yuborilgan), 12 shortfall yangi so'rov (batch_id bir xil) →
production. Do'kon 18 ni qabul qilganda 2 brak (sabab bilan) →
qty_accepted=16, brak=2 (cap tekshiradi) → yopilgan; markaz Poster
decrement writeback (dry-run rejimda log).

## 19. Ochiq savollar / keyingi qadam

1. Egasi qarorlari: **#8, #9, #10** (§15) — tavsiyalar berildi.
2. DB ko'tarilganda per-mahsulot Цех ro'yxati audit qilinadi (qaysi semi'lar
   workshop'siz NULL — ular «joyida yasaladi» tarmog'iga tushadi).
3. «Boshla» kelganda: F-A dan boshlaymiz (sxema), har faza alohida demo.
