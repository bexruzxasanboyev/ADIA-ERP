# ADIA ERP — Loyiha qo'llanmasi (CLAUDE.md)

Bu fayl ADIA ERP loyihasida ishlaydigan har bir Claude Code sessiyasi va agent uchun asosiy yo'riqnoma. Har sessiyada avtomatik yuklanadi.

## 1. Loyiha

**ADIA ERP** (mahsulot nomi: *CAKE ERP*) — non/tort/qandolat ishlab chiqarish va ta'minot zanjiri uchun **o'zini-o'zi to'g'rilaydigan ERP tizimi**.

- Zanjir: Xom-ashyo ombori → Ishlab chiqarish → Ta'minot bo'limlari → Markaziy sklad → Do'konlar.
- Asosiy g'oya: har mahsulotga min/max belgilanadi; ostatka min'dan tushganda tizim avtomatik to'ldirish (replenishment) tsiklini ishga tushiradi. Eng tepada — AI assistant.
- **Bitta kompaniya** ishlatadi — multi-tenant EMAS. Tenant/organization abstraksiyasi qo'shilmaydi.
- Savdo va ombor ma'lumotlari **Poster POS** platformasidan sinxronlanadi (akkaunt: `adia`) — qo'lda kiritilmaydi. API: `docs/adia-poster-api.md`, maxfiy kalitlar: `.env`.
- To'liq texnik topshiriq: `docs/TZ.md`. Qabul qilingan qarorlar: `docs/architecture/decisions.md`.
- Holat: greenfield — ilova kodi hali yozilmagan, MVP rejalashtirilmoqda.

## 2. Muloqot tili

- **Loyiha egasi bilan — o'zbek tilida (lotin yozuvi).** Barcha rejalar, hisobotlar, savollar o'zbekcha.
- **Kod, izohlar, commit xabarlari, identifikatorlar, fayl nomlari — ingliz tilida.**
- **UI matni — o'zbekcha**; raqam/sana mahalliy formatda.
- Domen atamalarining kod ekvivalenti: zayafka → `production_order`, ostatka → `stock`/`qty`, jo'natma → `shipment`, do'kon → `store`, bo'g'in → `location`. To'liq lug'at: `cake-erp-domain` skill.

## 3. Jamoa va vazifa taqsimoti (routing)

Team lead = asosiy sessiya (orkestrator). Egasini eshitadi, reja tuzadi, quyidagi subagentlarga `Agent` tool orqali vazifa beradi. **Subagentlar bir-birini chaqira olmaydi** — orkestratsiya faqat team lead zimmasida.

| Vazifa turi | Agent (`subagent_type`) |
|---|---|
| Arxitektura, DB sxema, state-machine, ADR | `system-architect` |
| Backend — Express API, PostgreSQL, replenishment engine, cron, RBAC, Telegram, Poster integratsiya | `backend-engineer` |
| Frontend — React+Vite+TS, shadcn/Tailwind, dashboard, assistant UI | `frontend-engineer` |
| UI/UX dizayn, dizayn-tizim, vizual referenslar | `ui-ux-designer` |
| Test strategiyasi, TDD, acceptance criteria, browser test | `qa-engineer` |
| Kod review + keraksiz/"trash" kod hisoboti | `code-reviewer` |
| Domen tadqiqi, NotebookLM bilim bazasi | `research-analyst` |
| Bozor/raqobat/trend tahlili | `market-analyst` |

Routing qoidasi: bitta artefaktga bitta perspektiva kerak bo'lsa — bitta agent to'g'ridan-to'g'ri. Mustaqil (bir-biriga bog'liq bo'lmagan) ishlarni parallel ishga tushir. `code-reviewer` faqat hisobot beradi — tuzatish vazifalarini team lead muhandis-agentlarga taqsimlaydi.

## 4. Ish jarayoni (majburiy)

1. Egasi vazifa beradi.
2. Team lead reja tuzadi (`planning-and-task-breakdown` skill) → **egasiga yuboradi**.
3. Egasi tasdiqlaydi.
4. Team lead agentlarga vazifa beradi; agentlar bajaradi.
5. `code-reviewer` natijani tekshiradi → team lead **hisobot** yig'adi.
6. Team lead egasiga hisobot beradi → tasdiq → keyingi qadam.

Qaytarib bo'lmaydigan amallar (deploy, real ma'lumotni o'chirish, tashqi xizmatga yuborish, `git push`) — egasining tasdig'isiz bajarilmaydi.

## 5. Texnik stek (TZ §10 — qat'iy)

| Qatlam | Texnologiya |
|---|---|
| Frontend | React + Vite + TypeScript; shadcn/ui + Tailwind (dark premium); Recharts |
| Backend | Node.js + Express; raw SQL query layer |
| DB | PostgreSQL |
| Auth | JWT + RBAC middleware |
| Fon ishlar | node-cron / BullMQ (replenishment skan, min/max qayta hisob) |
| Bot | Grammy (Telegram) |
| AI | Claude — tool/function calling DB ustida |
| Integratsiya | Poster POS API — savdo, cheklar, ombor qoldig'i sinxronizatsiyasi (`docs/adia-poster-api.md`) |
| Deploy | Hetzner VPS · PM2 · Nginx |

Stek TZ tomonidan belgilangan — egasining tasdig'isiz o'zgartirilmaydi.

## 6. Domen qoidalari

To'liq domen bilimi — **`cake-erp-domain` skill** (har ERP-logika vazifasida o'qing), `docs/TZ.md` va `docs/architecture/decisions.md`. Buzilmaydigan invariantlar va qoidalar:

1. Har `stock_movement` — atomar tranzaksiya (manba kamayadi, qabul oshadi, audit log yoziladi — yoki hammasi, yoki hech narsa).
2. Bitta `(product, location)` uchun bir vaqtda faqat bitta ochiq `replenishment_request` (debounce, dublikat yo'q).
3. Ostatka hech qachon manfiy bo'lmaydi (DB CHECK + ilova tekshiruvi).
4. min/max har `(location_id, product_id)` juftligida — har bo'g'inda har xil; dinamik min/max barcha bo'g'inlarda ishlaydi.
5. RBAC qattiq: har rol faqat o'z bo'g'inini ko'radi; PM/Admin butun zanjirni.
6. Har bo'g'in (location) o'z boshlig'iga (manager) ega — har `location` ga manager-foydalanuvchi biriktiriladi.
7. Ta'minot so'rovi (purchase/supply request) boshliq + skladchi ikkalasi tasdiqlagach kuchga kiradi (ikki bosqichli tasdiq).

## 7. Skill'lar va command'lar

`.claude/skills/` da 28 ta skill: 23 ta SDLC skill (Addy Osmani) + `find-skills` + 4 ta loyiha skill (`cake-erp-domain`, `notebooklm-knowledge-base`, `lazyweb-design-references`, `agentation-ui-feedback`). Sessiya boshida `using-agent-skills` meta-skill mos skillni tanlashga yordam beradi.

Command'lar: `/spec` `/plan` `/build` `/test` `/review` `/code-simplify` `/ship`. Yangi skill izlash: `find-skills` skill yoki `npx skills find`.

## 8. Bilim bazasi, dizayn, UI feedback

- **NotebookLM** (`notebooklm` MCP) — jamoaning bilim bazasi/xotirasi; grounded, iqtibosli javoblar. `research-analyst` boshqaradi. Skill: `notebooklm-knowledge-base`.
- **Lazyweb** (lazyweb.com) — real ilova UI referenslari. Skill: `lazyweb-design-references`.
- **Agentation** (`agentation` MCP) — egasi brauzerda UI'ni annotatsiya qiladi → agent aniq kontekst oladi. Skill: `agentation-ui-feedback`.
- **Figma** (`figma` MCP plugin) — dizayn fayllari, `ui-ux-designer` uchun.

## 9. Konventsiyalar

- TypeScript hamma joyda (frontend + backend); `any` dan qoching, strict rejim.
- O'zgarishlar kichik va atomar (`git-workflow-and-versioning` skill, ~100 qator commit).
- Har ERP operatsiyasi uchun test (`test-driven-development`); acceptance criteria — TZ §15 dan.
- Sirlar `.env` da — hech qachon kodda yoki commitda emas (`.env` git'ga yuklanmaydi).
- ADR (arxitektura qarorlari) — `docs/architecture/` da.

## 10. Repo strukturasi

```
.claude/    — agents/, skills/, commands/, hooks/, settings.json
docs/       — TZ.md, SETUP.md, adia-poster-api.md, references/, architecture/
apps/       — (Faza 1 da yaratiladi) api/ + web/
.mcp.json   — MCP serverlar
.env        — maxfiy kalitlar (git'ga yuklanmaydi); namuna: .env.example
CLAUDE.md   — bu fayl
```

## 11. Joriy holat

- **Faza 0 (bajarildi, 2026-05-22):** jamoa infratuzilmasi sozlandi; git init + baseline commit.
- **TZ §16 ochiq savollari hal qilindi (2026-05-22):** to'liq — `docs/architecture/decisions.md`. Asosiy: savdo/ombor ma'lumotlari Poster POS dan sinxronlanadi; xom-ashyo va markaziy sklad alohida; Yarim Fabrika ikki tomonlama oqim; dinamik min/max barcha bo'g'inlarda; ta'minot so'rovlari ikki bosqichli tasdiq; har bo'g'inning o'z boshlig'i bor.
- **Keyingi qadam:** `system-architect` Faza-1 (MVP) spec + DB sxemasini tayyorlaydi (Poster ma'lumot modeli mapping bilan) → reja egaga tasdiqlashga yuboriladi.
- Faza rejasi: TZ §14 (MVP → Faza 2 → Faza 3).
