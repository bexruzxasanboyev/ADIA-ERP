# Bo'limlar bog'lanishi va so'rov oqimi

> ADIA ERP'da bo'limlar (locations) bir-biriga qanday bog'langani va kim kimga
> so'rov yuborishi. Manba: `services/replenishment.ts`, `services/crossDeptRequest.ts`,
> migration `0026_location_flows.sql`. Sana: 2026-06-09.

## 1. Bo'limlar (locations) va turlari

| Bo'lim | Turi (`location_type`) | Vazifasi |
|---|---|---|
| Xom-ashyo ombori | `raw_warehouse` | Tashqi ta'minotchidan kelgan xom-ashyo (un, shakar…) |
| Tort sexi | `production` | Tort ishlab chiqaradi |
| Perojniy sexi | `production` | Perojniy / qandolat ishlab chiqaradi |
| Yarim Fabrika sexi | `production` | Yarim tayyor (зг) — krem, qaymoq va h.k. |
| Tort skladi | `sex_storage` | Tort sexining buferi |
| Perojniy skladi | `sex_storage` | Perojniy sexining buferi |
| Yarim Fabrika skladi | `sex_storage` | YF sexining buferi |
| Markaziy Sklad | `central_warehouse` | Hamma sexdan yig'adi, do'konlarga tarqatadi |
| Do'konlar (Kukcha…) | `store` | Yakuniy sotuv nuqtasi |

Har bo'limning **o'z boshlig'i (manager)** bor — so'rovni faqat shu odam
qabul / rad qiladi (Invariant 6).

## 2. Bog'lanishlar — ikki xil "sim"

Tizimda bog'lanish **ikki manbadan** o'qiladi.

### (a) `locations.parent_id` — so'rov yo'nalishi (1:N daraxt)

So'rov shu zanjir bo'ylab **yuqoriga** ko'tariladi. Har bo'limning "ustki bo'g'ini":

```
Do'kon ──parent──▶ Markaziy Sklad ──parent──▶ Production (sex) ──parent──▶ Xom-ashyo ombori
sex_storage ──parent──▶ o'z sexi (production)
```

### (b) `location_flows` — mahsulot fizik oqimi (M:N to'r)

```
Tort sexi      ──production_output──▶ Tort skladi
Tort sexi      ──production_output──▶ Yarim Fabrika skladi
Perojniy sexi  ──production_output──▶ Perojniy skladi
Perojniy sexi  ──production_output──▶ Yarim Fabrika skladi

Yarim Fabrika skladi ──bom_input──▶ Tort sexi        (qayta kirish — teskari halqa)
Yarim Fabrika skladi ──bom_input──▶ Perojniy sexi

Tort skladi          ──forward──▶ Markaziy Sklad
Perojniy skladi      ──forward──▶ Markaziy Sklad
Yarim Fabrika skladi ──forward──▶ Markaziy Sklad
```

> **Muhim**: `parent_id` = *so'rov yo'nalishi* (kim kimdan so'raydi),
> `location_flows` = *mahsulot fizik oqimi* (kim kimga jo'natadi). Ular
> qarama-qarshi yo'nalishda: pastki bo'g'in **so'raydi** (yuqoriga), yuqori
> bo'g'in **jo'natadi** (pastga).

## 3. Kim kimga so'rov yuboradi (routing qoidasi)

So'rov targeti `resolveRequestTarget` orqali aniqlanadi — **2 ta rejim**.

### Rejim A — oddiy "ustki bo'g'in" (default)

| So'rov yuboruvchi | So'rov boradi (target) |
|---|---|
| **Do'kon** | → **Markaziy Sklad** |
| **Markaziy Sklad** (yetishmasa) | → **Production / sex** |
| **Sex** (xom-ashyo kerak) | → **Xom-ashyo ombori** |
| **Xom-ashyo ombori** | → hech kim (root — tashqi xarid orqali) |

### Rejim B — yarim-tayyor override (TZ §6)

Agar so'ralayotgan mahsulot `type='semi'` (зг) bo'lib, `workshop_location_id`
to'ldirilgan bo'lsa — so'rov ustki bo'g'inga emas, balki **o'sha зг ni ishlab
chiqaruvchi отдел sklad'iga** boradi.

> Misol: Tort sexiga **krem** kerak → so'rov Markaziy Skladga emas, to'g'ridan-
> to'g'ri **Qaymoq / YF skladi**ga ketadi. Bu holatda target so'rovga "pin"
> qilinadi (RBAC + qabul handler bir xil sklad bilan ishlaydi).

## 4. So'rov hayotiy sikli (state machine)

Bir so'rov 10-statusli mashinadan o'tadi
(`NEW → CHECK_STORE_SUPPLIER → SHIP_TO_REQUESTER → CHECK_PRODUCTION_INPUT →
CREATE_PURCHASE_ORDER / CREATE_PRODUCTION_ORDER → PRODUCING → DONE_TO_WAREHOUSE
→ CLOSED / CANCELLED`), lekin foydalanuvchi **5 ta bosqich**ni ko'radi:

```
kutuvda ──▶ soralgan ──▶ qabul_qilingan ──▶ yuborilgan ──▶ yopilgan
(yangi)    (ishlab      (sex/skladdan       (do'konga      (do'kon qabul
           chiqilmoqda)  yetdi, tayyor)      jo'natildi,    qildi / rad etdi)
                                             rezerv)
```

- **Avtomatik**: skan-worker ostatka `min`dan tushganini ko'rsa, so'rovni
  o'zi yaratadi.
- **Qo'lda**: boshliq web yoki Telegram orqali yaratadi.
- **Partial fulfillment**: Markaziy sklad qisman jo'natadi, qolgani avtomatik
  production'ga so'rov bo'lib ketadi (yangi grouped request, bir xil `batch_id`).

## 5. Kanallar — qayerdan so'rov yuboriladi

- **Web (React)**: `pages/central` (Markaziy sklad inbox / dispatch),
  `pages/requests`, `pages/replenishment`, отдел workspace `/production`.
- **Telegram bot (Grammy)**: boshliq **ovozli** so'rov yuboradi
  ("10 napoleon kerak") → target manager'ga **✅ Qabul / ❌ Rad** inline
  tugmalari (`xreq:accept` / `xreq:reject`) keladi → "📥 Kelgan so'rovlar"
  ro'yxati.

## 6. Asosiy invariantlar

1. Bitta `(mahsulot, bo'lim)` uchun bir vaqtda faqat **bitta ochiq so'rov**
   (debounce, dublikat yo'q).
2. Har harakat **atomar** (ostatka kamayadi + oshadi + audit — yoki hammasi,
   yoki hech narsa).
3. Ostatka hech qachon manfiy emas (DB CHECK + ilova tekshiruvi).
4. RBAC: har bo'lim faqat o'z so'rovlarini ko'radi; target manager faqat
   o'ziga kelganni qabul qiladi.
