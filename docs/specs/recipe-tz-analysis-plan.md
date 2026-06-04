# Mahsulot Retsepti TZ — Tahlil va Reja

> Manba: `docs/Mahsulot retsepti tz.docx` (2026-06-05).
> Holat: **tahlil tugadi — egasi tasdig'ini kutmoqda (reja bosqichi).**
> Grounding: 3 ta parallel kod-tahlil (unit, self-cost, per-unit BOM) — fayl-referensli.

## Egasi qarorlari (2026-06-05)
- **TZ-1 Gramm:** bazada ham grammда saqlash (to'liq migratsiya), faqat displey emas.
- **Tartib:** hammasini ketma-ket (W1→W2→W3→W4).
- **Brutto/netto:** Claude aniqlaydi (test bilan).

## Wave-1 DIAGNOSTIKA NATIJALARI (2026-06-05, adia_erp_dev jonli)
- **D1 — qty_per_unit (TZ-3):** ✅ **TO'G'RI, 1000× bug YO'Q.** Prepack namunasida (банановый крем) `qty_per_unit / (brutto_gr/1000)` izchil = 1/yield; qiymatlar sane (0.34 kg banan / 1 kg krem). 2026-05-30 fix'dan keyin synclangan. → **Remediation (eski R1) KERAK EMAS.** Faqat ba'zi finished mahsulot magnitudasi (masalan baklajan 2.2kg/dona) shubhali — spot-tekshiruv.
- **D2 — cost NULL (TZ-2):** ❌ **OG'IR.** raw: 157/378 NULL; **semi: 1119/1119 NULL; finished: 294/294 NULL.** Poster `prepack.cost` import qilinmagan + NULL tarqalishi → barcha tort narxi "—".
- **D3 — brutto/netto:** ⚠️ **MUHIM** — 2339/5044 (46%) qatorда brutto ≠ netto. Cost asosi (brutto yoki netto) natijaga ta'sir qiladi → aniqlash shart (W2 ichida test bilan).

## Wave-2 NATIJALARI (2026-06-05)
- **Re-sync (`?entity=products`, 66s)** raw narxni Poster `structure_selfprice`'dan yangiladi. **Real Poster tortlar endi narx ko'rsatadi** (МЕДОВИК 6.6k, НАПОЛЕОН 121k...); avval ko'rilgan "—" faqat **dev-seed product 5** (Poster'siz) edi.
- **157 NULL raw — Poster'ning O'ZIDA narxsiz** (resale/ichimlik); re-sync o'zgartirmadi. C2 (NULL-propagation partial+flag) faqat ana shunday komponentli tortlar uchun foydali — ixtiyoriy.
- ⛔ **KRITIK (TZ-3 finished):** **49/198 finished mahsulot BATCH-tainted** — "1 dona" retsepti aslida butun partiya (ПЕЧЕНЬЕ: 1kg shokolad+10 tuxum/«1 dona»; ПАХЛАВА 19kg; ЭКЛЕР КГ 18kg). Sababi: Poster `menu.getProduct` finished uchun **yield (nechta dona) bermaydi** → ERP "1 dona" deб oladi. → Bu mahsulotlarning **narxi VA so'rovnoma miqdori partiya hajmicha shishган**. Wave-1 faqat prepack tekshirgan edi (to'g'ri); finished batch-taint endi aniqlandi.
- **Yechim:** finished mahsulotga **`recipe_yield` (1 retsept nechta dona chiqaradi)** maydoni — ishlab chiqarish boshlig'i kiritadi yoki AI taxmin qiladi; tizim `qty_per_unit / yield` bilan per-1-dona ga keltiradi. 146 to'g'ri mahsulot yield=1.

## TZ talablari (qisqacha)
1. **Gramm standarti** — barcha xomashyo/mahsulot bazada `gr`da; displey `[gr] gr ([kg] kg)`.
2. **Tan narx (self-cost) aniqligi** — Poster ↔ ERP sarf/tan narx mos emas, bir xil mantiqqa keltirish.
3. **Retsept "1 dona" tizimi** — partiyaviy (10 dona) retseptlar 1 donaga bo'linsin; buyurtma×(1-dona-sarf) → aniq so'rovnoma.
4. **Analiz/Nazorat** — har polufabrikat (masalan "Krem Napoleon") 1 birlikка aniq sarf bilan qayta hisoblanib, tizimda aks etsin.

---

## 1. Hozirgi holat vs TZ (gap-tahlil)

### TZ-1 — Gramm standarti  ⚠️ KATTA o'zgarish (lekin display-first mumkin)
**Hozir:** `Unit = 'kg' | 'l' | 'pcs'` (DB enum `unit_type`). Poster sync `g→kg`, `ml→l` ni ÷1000 qiladi (`seedSync.ts:71-137`). `qty_per_unit`, `cost_per_unit`, `stock.qty/min/max` — hammasi kg/l da. Displey: `formatQty()` + `UNIT_LABELS` (`kg`/`l`/`dona`). Grammda hech narsa ko'rsatilmaydi.

**Gap:** TZ ikki narsani so'raydi — (a) **saqlash** grammda, (b) **displey** `X gr (Y kg)`.
- **(a) to'liq gramm-saqlash:** DB enum'ga `g`/`ml` qo'shish + barcha tarixiy qiymatni ×1000 migratsiya + sync normalizatsiyani olib tashlash + NUMERIC aniqlik qayta sozlash. ~4 migratsiya, 3 servis, riskli (tarixiy stock/cost buziladi).
- **(b) faqat displey:** kg-saqlashni saqlab, `formatQtyDual(qty,unit)` → `"310 gr (0.31 kg)"` formatteri; ~30-40 call-site. Risksiz, foydalanuvchi ko'radigan maqsadga erishadi.

**Tavsiya:** **Display-first (b)** — MVP sifatida. Egasi non ustasi sifatida grammda o'ylaydi; `X gr (Y kg)` ko'rinishi asosiy ko'rinadigan yutuq. To'liq gramm-saqlash (a) — keyingi faza, agar Poster sync yoki aniqlik buni talab qilsa. `pcs/dona` — o'zgarmaydi (grammga aylanmaydi).

### TZ-2 — Tan narx mosligi  ❌ HAQIQIY ish (eng muhim)
**Hozir:** ERP faqat **xom-ashyo** narxini import qiladi (`structure_selfprice ÷ brutto ÷ 100`, `seedSync.ts:181-219` → `products.cost_per_unit`). Polufabrikat narxini **pastdan-yuqoriga qayta hisoblaydi** (`bom.ts:168-265`), Poster'ning tayyor `prepack.cost` qiymatini **e'tiborsiz qoldiradi**. Bitta komponent narxi NULL bo'lsa — butun retsept narxi NULL ("—", brauzerда ko'rilgan).

**Mos kelmaslik sabablari (6 ta):**
1. **Poster `prepack.cost` import qilinmaydi** → ERP qayta hisobi drift qiladi (eng katta sabab).
2. **Brutto vs Netto noaniqligi** — narx `structure_brutto` dan, Poster esa netto ishlatishi mumkin (~20-25% farq).
3. **NULL tarqalishi** — bitta yetishmagan narx butun retseptni NULL qiladi (jim).
4. **Per-node yaxlitlash** — har bosqichда yaxlitlash, Poster bir martalik yaxlitlaydi.
5. O'tgan 1000× bug (tuzatilgan) cost'ga ham ta'sir qilgan.

**Yechim:** (1) Poster `prepack.cost` ni to'g'ridan-to'g'ri import; (2) brutto/netto'ni aniqlash (Poster docs/test); (3) NULL tarqalishini to'xtatish (faqat null bo'lganlarini sanab, yetishmaganini ogohlantirish); (4) yaxlitlashni moslash; (5) yetishmagan xom-ashyo narxini audit+backfill; (6) ±0.01 test (НАПОЛЕОН, ШОКОЛАДНЫЙ ТОРТ).

### TZ-3 — Retsept "1 dona" tizimi  ✅ MANTIQ TAYYOR / ⚠️ ma'lumot riski
**Hozir:** Arxitektura **allaqachon per-1-dona** — `qty_per_unit` = "1 tayyor birlik uchun sarf" (`recipes` jadval CHECK, `bom.ts:136`, `productionOrder.ts:101` `needed = qty_per_unit × orderQty`, `nakladnoy.ts:224`). Buyurtma×sarf matematikasi **to'g'ri**.

**Gap:** Poster import'da **1000× bug** bor edi (2026-05-30 da kodда tuzatildi: `normaliseOut`, `seedSync.ts:131-137`) — lekin **eski sinxlangan ma'lumot 1000× xato bo'lib qolishi mumkin**; remediation migratsiya yo'q. **Yangi synclar to'g'ri.** Modifikatsiya (o'lcham variantlari) edge-case: grammni qat'iy taxmin qiladi.

**Yechim:** Hozirgi DB ma'lumotini tekshirish → agar buzilgan bo'lsa, Poster'dan qayta sync yoki remediation migratsiya. Modifikatsiya variantlarini ko'rib chiqish.

### TZ-4 — Polufabrikat per-1-birlik analiz  ✅ ASOSAN TAYYOR
**Hozir:** Rekursiv BOM nesting **to'g'ri** — stage-aware (hamir/krem/bezak), zagatovka ikki marta sanalmaydi (`nakladnoy.ts:200-286`). "Krem Napoleon" kabi polufabrikat 1-birlik sarfi to'g'ri yechiladi. Bu TZ-3 (`qty_per_unit` to'g'riligi) ga bog'liq.

**Gap:** Mantiqда yo'q. Asosan **verifikatsiya** + TZ-2 (cost analizi). Manual retsept tahririda "per 1 dona" semantikasini UI'da aniq ko'rsatish.

---

## 2. Reja (to'lqinlar)

### Wave 1 — Diagnostika & verifikatsiya (blocker, avval)
- **D1.** Hozirgi DB'da `qty_per_unit` 1000× buzilganmi? Diagnostika skript: prepack rows uchun `qty_per_unit` real Poster sarfiga solishtirish. → `backend-engineer`. **AC:** buzilgan qatorlar ro'yxati yoki "toza" tasdig'i.
- **D2.** `cost_per_unit` NULL bo'lgan xom-ashyolar audit (`SELECT ... WHERE type='raw' AND cost_per_unit IS NULL`). → `backend-engineer`. **AC:** yetishmagan narxlar ro'yxati + Poster'da bor/yo'qligi.
- **D3.** Brutto vs Netto — Poster `structure_selfprice` qaysi asosда? Test mahsulot (Napoleon) bilan Poster cost'ni ERP bilan solishtirish. → `research-analyst` + `backend-engineer`. **AC:** brutto yoki netto — qat'iy javob.

### Wave 2 — TZ-2 Tan narx (eng muhim funksional)
- **C1.** Poster `prepack.cost` ni import (`seedSync.ts` syncPrepacks) → `products.cost_per_unit` (semi) to'g'ridan-to'g'ri. → `backend-engineer`. **AC:** semi narxi Poster bilan ±0.01 mos.
- **C2.** NULL tarqalishini to'xtatish (`bom.ts:sumLineCosts`) — faqat hammasi null bo'lsa null; aks holda qisman sum + "yetishmagan komponent" ogohlantirish. → `backend-engineer`. **AC:** bitta yetishmagan narx butun retseptni NULL qilmaydi; UI yetishmaganini ko'rsatadi.
- **C3.** Brutto/netto'ni D3 javobiga ko'ra moslash. → `backend-engineer`. **AC:** narx asosi Poster bilan bir xil.
- **C4.** Yaxlitlashni moslash + ±0.01 test suite (НАПОЛЕОН, ШОКОЛАДНЫЙ ТОРТ). → `qa-engineer` + `backend-engineer`. **AC:** real Poster prepacklar ±0.01.

### Wave 3 — TZ-1 Gramm displey (display-first)
- **U1.** `formatQtyDual(qty, unit)` formatter — `"310 gr (0.31 kg)"`, `"500 ml (0.5 l)"`, `"24 dona"`. Backend `lib/units.ts` + frontend `lib/format.ts`. → `frontend-engineer` + `backend-engineer`. **AC:** weight/volume qiymatlar `gr (kg)`/`ml (l)`; pcs `dona`.
- **U2.** Call-site'larni yangilash — retsept, stock, replenishment, nakladnoy, dashboard. → `frontend-engineer`. **AC:** barcha miqdor ko'rsatuvchi joy dual-format; brauzer tasdiq.
- **U3.** (Ixtiyoriy/keyingi faza) To'liq gramm-saqlash migratsiya — egasi xohlasa. → `system-architect` ADR + `backend-engineer`. **AC:** alohida tasdiq bilan.

### Wave 4 — TZ-3/TZ-4 Ma'lumot remediation + verifikatsiya
- **R1.** D1 natijasiga ko'ra: buzilgan `qty_per_unit` ni Poster'dan qayta sync yoki remediation migratsiya. → `backend-engineer`. **AC:** barcha prepack `qty_per_unit` real per-1-dona.
- **R2.** Manual retsept tahriri UI'da "1 dona uchun" semantikasini aniq ko'rsatish (label/help). → `frontend-engineer`. **AC:** foydalanuvchi partiyaviy emas, per-dona kiritishini biladi.
- **R3.** Modifikatsiya (o'lcham variantlari) edge-case'ni ko'rib chiqish (`resolveModificationComponent`). → `backend-engineer`. **AC:** ml/dona asosli modlar to'g'ri.
- **R4.** Uchidan-uchiga test: Napoleon 30 dona buyurtma → so'rovnoma real grammda to'g'ri. → `qa-engineer`. **AC:** TZ algoritmi tasdiqlanadi.

---

## 3. Egasiga ochiq savollar
- **Q1 (TZ-1):** Gramm — **faqat displey** (`X gr (Y kg)`, risksiz) yetarlimi, yoki **bazada ham** grammда saqlash shartmi (og'irroq, tarixiy ma'lumot ×1000)?
- **Q2 (TZ-2/D3):** Poster sebestoimost'i **brutto** yoki **netto** asosдami? (Bilmasak, test mahsulot bilan aniqlaymiz — lekin egasi Poster'ni biladi.)
- **Q3 (umumiy):** Ustuvorlik — Tan narx (Wave 2) avvalmi yoki Gramm displey (Wave 3) avval? (Tan narx ko'proq "ichki aniqlik", gramm ko'proq "ko'rinadigan".)
- **Q4 (TZ-3):** Hozirgi DB ma'lumotini Poster'dan to'liq qayta sync qilsa bo'ladimi (1000× buzilgan bo'lsa), yoki tarixiy ma'lumotni saqlash kerakmi?
