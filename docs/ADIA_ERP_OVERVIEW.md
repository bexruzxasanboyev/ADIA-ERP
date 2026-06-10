# ADIA ERP — Loyiha haqida to'liq tushuncha

> Bu hujjat **texnik topshiriq emas**. Bu — tizimning **mohiyati va ishlashi** oddiy, tushunarli tilda. Maqsad: kim o'qisa — dasturchi bo'lsin, hamkor bo'lsin, xodim bo'lsin — ADIA ERP **nima qilishini, qanday ishlashini va nega kerakligini** to'liq tushunsin.

---

## 1. ADIA ERP nima?

ADIA ERP — bu **non, tort va qandolat ishlab chiqaradigan korxonaning butun ishini** boshqaradigan tizim. Xom-ashyo omboriga un, shakar, yog' kelgan paytdan boshlab — to mijoz do'konda tort sotib olgunига qadar bo'lgan **hamma jarayonни bir joyda** ko'rsatadi va boshqaradi.

Oddiy qilib aytganda: ADIA — bu **korxonaning miyasi**. U:
- Qayerda nima qancha borligini biladi,
- Nima kamayganini o'zi sezadi va o'zi to'ldirish buyrug'ini beradi,
- Har bir mahsulot va do'kon qancha foyda keltirayotganini ko'rsatadi,
- Xato yoki o'g'irlikни darhol ushlaydi,
- Va eng tepada — **sun'iy intellekt yordamchisi** bor: undan oddiy gap bilan so'rasangiz bo'ldi.

## 2. Qaysi muammoni hal qiladi?

Ilgari hamma narsa qo'lda yoki bosh-ko'z bilan boshqarilganda quyidagi muammolar bo'lardi:

- **Mahsulot tugab qoladi** — kimdir buyurtma berishni unutadi, do'kon javoni bo'sh qoladi, savdo yo'qoladi.
- **Ortiqcha ishlab chiqariladi** — keragidan ko'p tayyorlanadi, qoladi, isrof bo'ladi.
- **Foyda noaniq** — bir tort necha pulga tushadi, qancha foyda beradi — aniq bilинmaydi.
- **Xato va o'g'irlik bilinmaydi** — kassada noto'g'ri chek urilsa, ombor qoldig'i mos kelmasa — hech kim sezmaydi.
- **Vaqt ketadi** — har bir buyurtma, hisobot, sanoq qo'lda qilinadi.

ADIA ERP shu muammolarning **hammasini** hal qiladi: u **o'zini-o'zi to'g'rilaydi** — odamdan doimiy nazoratни talab qilmaydi.

## 3. Asosiy g'oya — "o'zini-o'zi to'g'rilaydigan" tizim

Bu — tizimning **eng muhim mohiyati**. Tushuntiramiz:

Har bir mahsulotга, har bir joyda (har bir do'kon, sklad, sex uchun alohida) ikkita chegara belgilanadi:
- **Minimal** — kamida shuncha turishi kerak,
- **Maksimal** — bundan ortiq saqlash shart emas.

Mahsulot **minimaldan pastга tushishi bilan**, tizim **o'zi** "to'ldirish kerak" deb buyruq (so'rov) yaratadi va uни zanjir bo'ylab yuboradi. Hech kim "esladim" deyishi shart emas — tizim **har 5 daqiqada** hamma narsani tekshirib turadi.

> Misol: Kukcha do'konida "Napoleon" minimaldan tushdi → tizim o'zi markaziy skladdan so'raydi → markaziy skladda ham kam bo'lsa → sexga ishlab chiqarish buyrug'i ketadi → sex kremga muhtoj bo'lsa → Qaymoq sexidan so'raydi. **Hammasi avtomatik**, zanjir bo'ylab.

Va har bir harakat **yozib boriladi**: kim, qachon, nima qildi. Hech narsa yashirin qolmaydi.

## 4. Ta'minot zanjiri — mahsulot qanday yo'l bosadi

Korxona bir necha **bo'g'in**dan iborat. Mahsulot ular orqali quyidagicha harakatlanadi:

```
   XOM-ASHYO OMBORI          (un, shakar, yog', tuxum, krem uchun xom-ashyo...)
          │
          ▼
        SEXLAR               (Tort sexi · Perojniy sexi · Yarim Fabrika · Qaymoq sexi)
   ┌──────┴───────┐           — bu yerda mahsulot pishiriladi / tayyorlanadi
   │ har sexning  │
   │ o'z skladi   │           (Sex skladlari — tayyor va yarim tayyor maxsulot saqlanadi)
   └──────┬───────┘
          ▼
     MARKAZIY SKLAD          — hamma sexdan yig'adi, do'konlarga tarqatadi
          │
          ▼
        DO'KONLAR            (Kukcha · Rabochiy · Chig'atoy · ...)
          │
          ▼
         MIJOZ               — sotib oladi (kassada, Poster orqali)
```

Har bir bo'g'in **bir-biriga bog'langan**. Yuqorida aytilganidek, biror joyda mahsulot kamaysa, so'rov **avtomatik** ravishda yuqori bo'g'inga ketadi.

Har bir bo'g'inning **o'z boshlig'i** bor — u faqat o'z bo'g'inini ko'radi va boshqaradi. Faqat egasi (rahbar) **butun zanjirni** ko'radi.

## 5. Poster bilan bog'liqlik — kassa o'zi gapiradi

Do'konlarda **Poster** (kassa dasturi) ishlatiladi. Har bir savdo, har bir chek, kassa smenasi, seyfdagi pul — **avtomatik ravishda** ADIA ERPга oqib keladi. Egasi savdoни qo'lda kiritib o'tirmaydi.

ADIA ERP — bu **Poster ustidagi aql qatlami**. Poster "nima sotildi" deb aytadi, ADIA esa shu ma'lumotга qarab:
- Ombor qoldig'ini yangilaydi,
- Nima kamayganini hisoblaydi,
- Har do'kon va sotuvchining savdosini ko'radi,
- Xato cheklar va mos kelmagan qoldiqларни ushlaydi.

> Muhim: Poster — savdo va ombor **manbasi**; ADIA — uни **boshqaradigan, tahlil qiladigan va to'g'rilaydigan** miya. Savdo ma'lumotlari qo'lda kiritilmaydi.

## 6. Bir kun qanday o'tadi (jonli misol)

**Ertalab.** Tizim rahbarga ko'rsatadi: qaysi mahsulot kam qolgan, bugun nima ishlab chiqarish kerak. Sexlarга ishlab chiqarish so'rovlari tushadi.

**Ishlab chiqarish.** Sex tortни pishirishdan oldin o'ylaydi: "**tayyor yarim-fabrikatim bormi?**" Agar krem yoki hamir tayyor bo'lsa — undan foydalanadi; bo'lmasa — retsept bo'yicha xom-ashyo omboridan kerakli narsalарни so'raydi. Bir necha tort uchun kerak bo'lgan umumiy krem **bitta so'rov** bo'lib yig'iladi (har biriga alohida emas).

**Krem alohida.** Krem ko'p ishlatilgani uchun, **Qaymoq sexi** alohida bo'lim sifatida ajratilган. Boshqa sexlar undan krem so'raydi, u tayyorlaydi va yetkazib beradi.

**Tarqatish va savdo.** Markaziy sklad tayyor mahsulotni do'konларга tarqatadi. Do'konda mijoz sotib oladi → Poster orqali savdo bo'ladi → ma'lumot darhol ADIA'ga keladi → qoldiq kamayadi → kerak bo'lsa yangi so'rov boshlanadi.

**Kechqurun.** Kassir Telegram orqali kun-oxiri hisobotini topshiradi (rasxod, qoldiq, karta puli). Tizim uни **Poster seyfi bilan solishtiradi** — agar farq bo'lsa, mas'ul shaxsга darhol ogohlantirish ketadi. Qisman sotilgан tortlar (masalan, yarmi sotilib yarmi qolgan) **to'g'ri hisoblanadi**.

## 7. Tizim nimalarni qiladi — barcha imkoniyatlar

Tizim 15 ta yo'nalishni qamrab oladi. Mana ularning **biznes ma'nosi** (texnik tafsilotsiz):

1. **Bo'limlar bog'liqligi** — butun zanjir bir-biriga ulangan; kam qolgan narsani tizim o'zi to'ldiradi.
2. **Ishlab chiqarish mantig'i** — sex tayyor yarim-fabrikatdan foydalanadi yoki noldan tayyorlaydi; kerakli xom-ashyo umumiy so'rovга yig'iladi.
3. **Mahsulot ma'lumotnomasi** — barcha mahsulot bitta ro'yxatda: xom-ashyo, yarim tayyor, tayyor — har birining tannarxi bilan.
4. **Poster bilan moslash** — mahsulotlar Poster bilan avtomatik bog'lanadi, qo'lda kiritish shart emas.
5. **Sexlararo bog'lanish** — sexlar bir-biriga material/yarim-mahsulot uzatadi; katta mahsulotni bir necha sex birga tayyorlaydi.
6. **Qaymoq krem bo'limi** — krem uchun alohida sex: boshqalардан so'rov oladi, tayyorlaydi, yetkazadi; o'z skladi bor.
7. **Ishlab chiqarish KPI** — har mahsulotning **haqiqiy tannarxi** (material + kommunal + ish haqi) va **foydasi** ko'rinadi.
8. **Do'kon KPI** — har do'kon **va har sotuvchi** uchun oylik savdo **rejasi**, bajarilish **foizi**, **o'sish** va **reyting**. Kim ortda qolgani darrov ko'rinadi.
9. **Kassa tafovuti (fors-major)** — noto'g'ri/ortiqcha sotuv va manfiy qoldiq **deyarli real vaqtda** ushlanadi; mas'ulга ogohlantirish ketadi. Bu — xato va o'g'irlikка qarshi himoya.
10. **Ombor sinxronizatsiyasi** — Poster'dagi qoldiq ADIA bilan avtomatik mos turadi.
11. **Bo'lak↔butun hisobi** — tort butun pishirib, bo'lak qilib sotiladi; tizim "3 bo'lak sotildi, 7 qoldi" deb **to'g'ri hisoblaydi**.
12. **Yangi mahsulot ishlab chiqarish** — Poster'da yo'q yangi mahsulotни ham yaratib, ishlab chiqarib, sotuvga chiqarish mumkin.
13. **Ishlab chiqarish so'rovi** — buyruq yaratiladi va **AI savol beradi**: "tayyordan yoki 0dan?", "kremni tayyorlaymizmi yoki ombordan olamizmi?".
14. **Ombor so'rovi (ikki tasdiq)** — xom-ashyo so'rovи **boshliq + skladchi** ikkalasi tasdiqlagandan keyingina kuchга kiradi (xatoning va suiiste'molning oldini oladi).
15. **Kassir boti** — kassir Telegram orqali kun-oxiri hisobotini topshiradi, tizim Poster seyfi bilan solishtiradi.

## 8. Sun'iy intellekt yordamchisi (AI)

Tizimning eng tepasida **AI yordamchi** turadi. Unга **oddiy gap** bilan murojaat qilasiz:

- *"Markaziy skladda nima qizil (kam) qolgan?"* — javob beradi.
- *"Bugun qancha savdo bo'ldi?"* — ko'rsatadi.
- Telegram'да **ovozli xabar** yuborsangiz ham bo'ladi: *"10 ta Napoleon kerak"* — tizim uни tushunib, so'rov yaratadi.

AI nafaqat javob beradi, balki **harakat ham qila oladi** (masalan, so'rov yaratish) — lekin har doim **sizning tasdig'ingiz bilan**, o'zboshimchalik bilan emas.

## 9. Telefon orqali boshqaruv (Telegram)

Hamma narsani telefondan boshqarish mumkin:
- Muhim ogohlantirishlar Telegram'ga keladi (mahsulot tugadi, xato chek, tafovut...),
- So'rovларни **bitta tugma** bilan tasdiqlash/rad qilish,
- Kassirлар hisobotни Telegram'da topshiradi,
- Ovoz orqali buyruq berish.

## 10. Kim nimani ko'radi (rollar)

Har kim **faqat o'ziga tegishlисини** ko'radi — bu tartibni va xavfsizликни ta'minlaydi:

| Rol | Nimani ko'radi/qiladi |
|---|---|
| **Rahbar (egasi)** | **Butun zanjirni** — hamma do'kon, sklad, sex, foyda, hisobot |
| **Do'kon boshlig'i** | Faqat o'z do'koni: savdo, qoldiq, so'rovlar |
| **Sex boshlig'i** | Faqat o'z sexi: ishlab chiqarish, yarim tayyor, so'rovlar |
| **Sklad boshlig'i** | Faqat o'z skladi: kirim/chiqim, so'rovlar |
| **Kassir** | O'z smenasi: kun-oxiri hisobot |

## 11. Tizimning foydasi — nega bu muhim

- ✅ **Javon hech qachon bo'sh qolmaydi** — tizim o'zi to'ldiradi.
- ✅ **Isrof kamayadi** — keragidan ortiq ishlab chiqarilmaydi.
- ✅ **Foyda aniq ko'rinadi** — har mahsulot, do'kon, sotuvchi bo'yicha.
- ✅ **Xato va o'g'irlik ushlanadi** — kassa tafovuti darhol bilinadi.
- ✅ **Vaqt tejaladi** — buyurtma, hisobot, sanoq avtomatlashtirilган.
- ✅ **Qarorlar ma'lumotga asoslanadi** — taxminга emas.
- ✅ **Hamma joydan boshqariladi** — telefon, brauzer, ovoz orqали.

## 12. Hozirgi holat

Tizimning **yadrosi to'liq ishlaydi**: ta'minot zanjiri, ishlab chiqarish, Poster bilan integratsiya, narx va foyda hisobi, AI yordamchi, Telegram bot — barchasi tayyor va **jonli ma'lumot bilan** ishlamoqda.

15 ta yo'nalishning hammasi qurib bo'lindi, jumladan eng so'nggi qo'shilganlari:
- **Kassa tafovutlari** (xato cheklar va manfiy qoldiqlar hisoboti) — real Poster ma'lumoti bilan ishlayapti,
- **Qaymoq krem bo'limi** — alohida sex sifatида,
- **Do'kon va sotuvchi KPI** — reja, foiz, reyting,
- **Kassir solishtiruvi** — Poster seyfi bilan,
- **Bo'lak↔butun inventarizatsiya** — qisman sotilган tortlar uchun.

Tizim ish faoliyatini boshlаshга **deyarli tayyor**. Qolgan ish asosан — real ma'lumotларни (masalan, qaysi krem qaysi sexniki, bir tort necha bo'lakка bo'linishi) kiritish va yakuniy sinov.

---

*Bu hujjat ADIA ERP'ning mohiyati va ishlashini biznes nuqtai nazaridan tushuntiradi. Texnik tafsilotlar (ma'lumotlar bazasi, API, kod) alohida texnik topshiriqда — `docs/ADIA_ERP_TZ.docx`.*
