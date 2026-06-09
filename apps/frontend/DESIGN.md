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

## 8. Maqsadli his (vibe)

Linear/Vercel uslubidagi qorong'u premium: tinch grafit sirtlar, bitta cobalt aksent, pill-badge'lar, mayin 1px "lit edge" soyalar, zich lekin nafas oladigan jadvallar, uppercase mikro-yorliqlar. Bezak uchun gradient/glow qo'shmang — faqat tokenlardagilar.
