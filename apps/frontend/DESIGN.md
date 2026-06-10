# ADIA ERP — Design Contract (redesign 2026-06)

Bitta maqsad: **har bir sahifa bir xil dizayn tilida gapiradi.** Ad-hoc stil taqiqlanadi — quyidagi qoidalar majburiy.

## 0. Manba

Barcha vizual qarorlar `src/components/ui/*` primitivlarida va `src/index.css` tokenlarida yashaydi. Sahifa kodi FAQAT primitivlar + token-classlardan foydalanadi. Hex/rgb/zinc/slate/gray kabi xom Tailwind ranglari sahifa kodida TAQIQLANADI — faqat semantik tokenlar (`bg-card`, `text-muted-foreground`, `border-border`, `bg-success/10`, `text-chain-store`, `bg-surface-2` ...).

## 1. Card

- Har qanday "panel/box/karta" → `<Card>` (`@/components/ui/card`). Raw `<div className="rounded-… border …">` yozish taqiqlanadi.
- Card ichidagi ichki bo'lim (nested panel) → `rounded-lg border border-border/60 bg-surface-3 p-3` — yagona ruxsat etilgan raw ko'rinish; iloji bo'lsa shu kombinatsiya aynan shu tartibda.
- Sarlavha: `<CardHeader className="pb-3">` + `<CardTitle>` (text-base). Kichik izoh → `<CardDescription>`.
- Bo'lim ichidagi mikro-sarlavha (kicker): `text-xs font-medium uppercase tracking-wider text-muted-foreground`.
- Statistik card (KPI): qiymat `text-2xl font-semibold tabular-nums tracking-tight`, label kicker uslubida, delta `Badge` bilan.
- Hoverda ko'tariladigan interaktiv card: `hover:shadow-card-hover hover:border-border-strong` (faqat bosiladigan cardlarda).

## 2. Button

- Har qanday bosiladigan amal → `<Button>` (`@/components/ui/button`). Raw `<button className="…">` faqat ikon-only inline holatda ruxsat: `<Button variant="ghost" size="icon">` ishlating baribir.
- Variant tanlash: asosiy amal (saqlash/yuborish) — `default`; ikkilamchi — `outline`; xavfli — `destructive`; jim amal (yopish, bekor) — `ghost`; jadval ichi linklari — `link`.
- Bitta kontekstda faqat BITTA `default` (primary) tugma.
- Ikonli tugma: `<Icon className="size-4" />` — gap allaqachon primitivda.

## 3. Badge / status

- Holat ko'rsatkichi → `<Badge variant="success|warning|danger|info|secondary|outline">` — pill (rounded-full). O'zicha rangli span yasash taqiqlanadi.
- Status nuqtasi kerak bo'lsa: `<span className="size-1.5 rounded-full bg-current" />` Badge ichida.

## 4. Forma

- Matn → `<Input>`, raqam → `<NumberInput>` (raw type=number TAQIQLANGAN), tanlov → `<Select>`, ko'p qator → `<Textarea>`, yorliq → `<Label>`.
- Hammasi h-9; tugma default ham h-9 — qatorlar tekis turadi.
- Forma qatori: `<div className="space-y-1.5">` (Label + control), bloklar orasi `space-y-4`.

## 5. Jadval

- `<Table>` primitivlari. Thead avtomatik `bg-muted/40` + uppercase — qo'shimcha stil bermang.
- Raqam ustunlari: `text-right tabular-nums`.
- Bo'sh holat: `PageState` komponenti (`@/components/PageState`).

## 6. Sahifa karkasi

- Sahifa sarlavhasi bloki: `text-xl font-semibold tracking-tight` + ostida `text-sm text-muted-foreground` izoh.
- Vertikal ritm: bo'limlar orasi `space-y-6`, grid `gap-4` (zich joylarda) yoki `gap-6`.
- KPI qatori: `grid gap-4 sm:grid-cols-2 xl:grid-cols-4`.

## 7. Taqiqlar (chetlab o'tish yo'q)

1. Sahifa kodida `rounded-* border` kombinatsiyali raw card divlar (1-banddagi nested istisnodan tashqari).
2. Raw `<button>`.
3. Xom ranglar: `bg-zinc-*`, `text-gray-*`, `#hex`, `rgb()`.
4. `shadow-lg/md/sm` ni sahifada qo'lda berish — soyalar faqat primitivlardan (`shadow-card`, `shadow-pop`).
5. `p-6`/`p-8` bilan o'zboshimcha padding — Card o'z paddingiga ega.
6. `text-lg`+ sarlavhalarni card ichida ishlatish (CardTitle text-base).

## 8. Status tizimi v2 — "qizil toshqin" taqiqlanadi

Eski uslub (qizil border + qizil qiymat + qizil badge bir cardda) TAQIQLANADI. Holat KARTANI emas, BITTA elementni bo'yaydi:

- Card har doim neytral: `<Card>` (border/rang o'zgarmaydi, status uchun border bo'yalmaydi).
- Holat ko'rsatkichi: faqat `<Badge variant>` (pill, o'ng yuqorida) + `<StockMeter>` to'ldirish rangi.
- Qiymat (qty) rangi: default `text-foreground`; FAQAT qty=0 da `text-destructive`, min'dan past bo'lsa `text-warning`. Boshqa hech narsa qizarmasin.

### Stok kartasi v2 (do'kon/markaziy/sklad mahsulot kartalari)

```
┌──────────────────────────────────┐
│ Mahsulot nomi (truncate)   [Badge]│  ← font-medium text-sm; Badge o'ngda
│ 🏪 Lokatsiya · turkum             │  ← text-xs text-muted-foreground
│                                  │
│ 4 000 gr  (4 kg)                 │  ← text-xl font-semibold tabular-nums
│ ▓▓▓▓▓▓░░|░░░░░░░░               │  ← <StockMeter ratio minRatio tone>
│ Min 1 kg          Max 2 kg       │  ← text-xs text-muted-foreground, justify-between
└──────────────────────────────────┘
```

- `<StockMeter>` — `@/components/ui/stock-meter`: `ratio = qty/max`, `minRatio = min/max`, `tone`: qty<=0 → `danger`, qty<min → `warning`, aks holda `success` (min/max yo'q bo'lsa `neutral`, meter ko'rsatilmaydi ham bo'ladi).
- "Qoldiq" / "Min / Max" so'z-label qatorlari OLIB TASHLANADI — meter + ikki chetdagi min/max o'zi tushuntiradi.
- Grid: `grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4` — kichikroq, zichroq kartalar.

### Filtr tablari

`fullWidth` segmented tablar (butun enini cho'zilgan) TAQIQLANADI — kompakt `inline-flex` segmented, hisob label ichida: `Hammasi · 66`. Holat tablarida nuqta-indikator mumkin: `● Tugagan · 12` (nuqta `text-destructive`).

## 9. Maqsadli his (vibe)

Linear/Vercel uslubidagi qorong'u premium: tinch grafit sirtlar, bitta cobalt aksent, pill-badge'lar, mayin 1px "lit edge" soyalar, zich lekin nafas oladigan jadvallar, uppercase mikro-yorliqlar. Bezak uchun gradient/glow qo'shmang — faqat tokenlardagilar.
