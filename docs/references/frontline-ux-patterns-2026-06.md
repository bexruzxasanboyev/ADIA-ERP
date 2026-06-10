# Frontline UX Patterns — Idoralararo So'rovlar va Bajarish
# Global Bozor Tadqiqoti: AQSh, Yevropa, Xitoy, Rossiya/MDH
*Tuzilgan: 2026 yil Iyun — ADIA ERP Bozor Tahlili*
*Tadqiqotchi: market-analyst subagent*

---

## O'ZBEKCHA IJROIYA XULOSASI (Egaga — 30 qator)

**Muammo:** Joriy Jira-uslubi kanban xodimlar uchun haddan tashqari murakkab. Eganing so'zi: "Xuddi chatdek bo'lsin."

**Nima topildi (4 mintaqadan):**
- **AQSh (Toast/Square/Fresh KDS, Uber Eats, DoorDash):** Har oshxona stansiyasi — bitta vertikal yoki gorizontal navbat. Rang = vaqt o'tishi (yashil→sariq→qizil). "Bump" = bitta teginish bilan bajarildi. Uber Eats merchantlari: yangi buyurtma = yashil chaqnash + tovush, keyin "Qabul qilish" tugmasi. DoorDash 2025: "Needs Action" tab, rang kodlangan kartalar, 5-daqiqalik prep vaqt sozlash.
- **Yevropa (Choco, REKKI, Pepper, SAP Fiori):** Choco va REKKI — eng muvaffaqiyatli chat-uslubi buyurtma: "3 teginish = jo'natildi." REKKI dizayn falsafasi: "Bitta ekran — bitta asosiy tugma, klaviatura zarur emas." Katoo 2023-yilda Choco tomonidan sotib olindi. SAP Fiori My Inbox: barcha tasdiqlash vazifalari bir "kirish qutisi"da, mobil qurilmada bir teginish.
- **Xitoy (Meituan, Ele.me, WeChat mini-dastur, Hualala, Keruyun):** Meituan — kuniga 90 million buyurtma (2025), merchant ilovasi ovozli signal + avtomatik tasdiqlash. WeChat mini-dastur B2B: restoran QR kodini skanerlaydi, ro'yxat tuzadi, "Yuborish" tugmasi. Hualala: 400 000+ restoran, POS+KDS+ta'minot zanjiri bitta platformada. Xitoy modeli: "chat-savdo" = umumiy WeChat guruhida buyurtma, supplier tomonida bir teginish.
- **Rossiya/MDH (iiko, r_keeper, Yandex.Eda, Quick Resto):** iiko iikoSousChef — MDH bozori lideri (Toshkentda Zetta Group orqali). Oshpaz "Tayyorlanmoqda" tugmasini bosadi → vaqtomer boshlanadi → "Tayyor" → tarelka ofitsiant ekranida ko'rinadi. r_keeper StoreHouse — multi-sklad, yarim fabrikat zanjiri uchun; iiko esa bulutli. iikoInventory mobil ilovasi: barcode, foto-qidirish, 2 haftada parol kiritmasiz ishlaydi. Poster POS (eganing hozirgi tizimi): mobil, haqiqiy vaqt zaxira hisoboti, kam qoldiq ogohlantirishlari.

**ADIA uchun 3 ta eng muhim qadam (tartiblangan):**
1. **Har rol uchun bitta asosiy ekran — karta lenti** (do'kon, markaziy sklad, отдел, homashyo). Kanban faqat menejer uchun "Batafsil" tabida.
2. **Yangi vazifa uchun tovush + chaqnash signali** (brauzer Audio API + Telegram push) — shovqinli non-pishirish muhitida zarur.
3. **Har qabul ekranida inline brak + qisman bajarish** (ordered → received + brak tikuvchisi) — markaziy sklad va xom-ashyo omborigacha kengaytirish (do'kon allaqachon 0045 migratsiyasida bor).

---

## 1. TADQIQOT METODOLOGIYASI VA MANBALAR

| Geografiya | Mahsulotlar tadqiq qilindi | Manba turi |
|---|---|---|
| AQSh | Toast KDS, Square KDS, Fresh KDS, GoTab KDS, Uber Eats merchant, DoorDash Order Manager, MarketMan, Cut+Dry, BlueCart, Pepper AI | Rasmiy hujjatlar, G2/Capterra sharhlar, dev bloglar |
| Yevropa | Choco (DE), REKKI (UK), Katoo (ES, Choco tomonidan sotib olingan), Pepper (DE/US), SAP Fiori My Inbox (DE), ServiceNow mobile | Rasmiy saytlar, dizayn case study'lar |
| Xitoy | Meituan merchant app, Ele.me/Taobao Flash Purchase, WeChat mini-dasturlar, Hualala, Keruyun, Sunami D2s KDS | Wikipedia, PitchBook, EqualOcean, marketing tadqiqotlari |
| Rossiya/MDH | iiko iikoSousChef, iikoInventory, r_keeper StoreHouse+KDS, Yandex.Eda vendor app, Quick Resto KDS, Poster POS | Rasmiy hujjatlar, picktech.ru, rokass.ru tahlillar |
| Bog'liq sanoat | Wherefour, Cybake, FlexiBake (non ERP), Odoo 18/19 barcode receive, ServiceNow Now Mobile | G2 sharhlar, rasmiy hujjatlar |

**Tadqiqot sanasi:** 2026 yil 10-iyun.

**Eslatma ishonchlilik haqida:** Xitoy merchant-side UX hujjatlari ingliz tilida kamdan-kam uchraydi; Meituan/Ele.me merchant interface tafsilotlari tadqiqot davrida to'liq ma'lumot beruvchi inglizcha manba topilmadi (bu bo'limda "ehtimol" belgilangan).

---

## 2. AQSh — OSHXONA DISPLEY TIZIMLARI (KDS)

### 2.1 Toast KDS

**Manba:** [Toast KDS Platform Guide](https://doc.toasttab.com/doc/platformguide/platformKDSOverview.html), [Toast KDS All Day View](https://support.toasttab.com/en/article/KDS-All-Day-1493055871075), [Toast KDS Routing Rules](https://doc.toasttab.com/doc/platformguide/platformKDSWorkflowWithRoutingRules.html)

**Asosiy UI xususiyatlari:**
- Buyurtmalar **gorizontal navbatda kartalar sifatida** ko'rsatiladi (eng eski chap tomonda, eng yangi o'ng tomonda).
- **Rang kodlash:** Karta sarlavhasi yosh bo'yicha o'zgaradi — yashil (o'z vaqtida) → sariq (yaqinlashyapti) → qizil (kechikkan). Bu sanoat standarti.
- **Bump mexanikasi:** Ikki marta teginish yoki suring = bu stansiyada bajarildi. Bitta belgi = faqat bu stansiyada; ikki belgi = hamma stansiyada; sariq nuqta = qisman (ko'p stansiyali).
- **"All Day" ko'rinishi:** Alohida rejim — har bir mahsulot uchun barcha faol buyurtmalar bo'yicha jami son ko'rsatiladi ("Napoleon — 12 ta"). Oshpaz sanab o'tirmasdan bir vaqtda massiv tayyorlash uchun.
- **Production Item Count:** Ingredientlar darajasida jami — "bugunngi barcha buyurtmalar uchun necha kg un kerak" ko'rinadi.
- **Stansiya marshrutlash:** Har bir KDS terminali faqat o'z stansiyasi mahsulotlarini ko'radi. "Expediter" rejimi — barcha stansiyalarning tugash holati ko'rinadi.
- **Yangi buyurtma:** Tovush signali + chaqnash animatsiyasi.
- **Hardware:** Toast Flex 3 — oldingi avloddan 2x tezroq. Yog'li qo'llar uchun katta teginish maydonlari.

**Dizayn tamoyili:** Bir terminal = bir navbat = bitta asosiy harakat (bump). Navigatsiya, menyular, filtrlar yo'q.

---

### 2.2 Fresh KDS

**Manba:** [Fresh KDS Features](https://www.fresh.technology/kitchen-display-system), [Fresh KDS Display Modes](https://www.fresh.technology/blog/kds-display-modes), [Fresh KDS Blog: 17 Features](https://www.fresh.technology/blog/kitchen-display-system-features-you-need)

Fresh KDS — mustaqil KDS kompaniyasi (POS qo'shimchasi emas), iOS va Android. Ko'plab POS tizimlari bilan integratsiya.

**To'rtta ko'rsatish rejimi:**
1. **Classic View (Single Rail):** Buyurtmalar bitta gorizontal qatorda, chapdan o'ngga. Chap-o'ng analog — an'anaviy qog'oz bilet relsi kabi. Soddalik — har bir xodim faqat o'z ketma-ketligiga e'tibor beradi.
2. **Split View:** Ikkita gorizontal qator — buyurtma turi bo'yicha (masalan, zalda vs olib ketish). Ustuvorlik bo'yicha qisman saralash.
3. **Tiled View (Grid):** Katakchalar to'ri — ko'proq buyurtmani bir vaqtda ko'rish. Juda band oshxona uchun.
4. **Take-Out View:** Olib ketish/yetkazib berish/drive-thru buyurtmalarini alohida kuzatish uchun maxsus rejim.

**Muhim xususiyatlar:**
- **Ingredient All Day Counts:** Barcha faol buyurtmalar bo'yicha har bir ingredientning umumiy soni — isrof kamaytiradi.
- **Item Summary:** Barcha faol biletlardagi elementlarning haqiqiy vaqtli umumiy ko'rinishi — jamoaga tayyorgarlik holati va aniqlikni kuzatish imkonini beradi.
- **Bump Bar qo'llab-quvvatlash:** Logic Controls KB1700 USB Bump Bar — ekranga tegmasdan boshqarish. Tozalik + tezlik uchun.

**Raqobatdosh afzallik:** Har qanday POS bilan ishlaydi; konfiguratsiya moslashuvchanligi Toast'ga qaraganda yuqori.

---

### 2.3 Square KDS

**Manba:** [Square KDS Android Setup](https://squareup.com/help/us/en/article/7944-get-started-with-square-kds-android), [Square KDS Complete Orders](https://squareup.com/help/us/en/article/8171-complete-orders-with-square-kds)

- 2024-yildan boshlab faqat Android.
- **Expeditor rejimi:** Barcha stansiyalar tugash holatini bir ekranda ko'radi.
- Buyurtmani to'ldirish: individual KDS'dan yoki butun joydagi barcha KDS'dan bajarildi deb belgilash.
- **Bump bar yo'q** (Fresh KDS'dan farqli); faqat sensorli ekran.
- Narxi: qulay (Android hardware).

**Dizayn diqqati:** "Juda oddiy ishlatish" — minimal o'qitish talab qiladi.

---

### 2.4 GoTab KDS

**Manba:** [GoTab KDS Product Page](https://gotab.com/products/kitchen-display-system-kds), [GoTab Ultimate KDS Guide 2025](https://gotab.com/latest/the-ultimate-guide-to-kitchen-display-systems-in-2025), [GoTab Product Routing](https://gotab.com/features/product-routing)

- **Dinamik marshrutlash:** Buyurtma qayerdan kelib tushgani asosida (zal, bino, bar, food hall stantsiya) to'g'ri stansiyaga yo'naltiradi.
- **Smart batching (gruppalash):** Belgilangan vaqt oynasi ichida tushgan buyurtmalarni birlashtiradi — runner bir marta boradi.
- **Delivery konsolidatsiyasi:** Bir stol yoki zona bo'yicha birlashtirilgan yetkazib berish.
- Ekspoze ekrani: ko'p stansiyali holat ko'rinishi.

---

### 2.5 KDS UX Case Study — Qizil Rang Muammosi

**Manba:** [Medium: Osama Haashir — KDS UX Redesign](https://medium.com/@osamahaashir/cooking-up-success-revamping-kitchen-display-system-kds-ux-case-study-6a6c92784fb9)

Real loyiha xulosalari:

**Muammo:** Hamma joyda qizil rang — holat farqini ajratib bo'lmay qoldi. Xodimlar qaysi karta haqiqiy kechikkan, qaysi biri boshqa tur ekanini ajrata olmadi.

**Yechim:**
- Rang ikki o'lchovli bo'ldi: **Buyurtma turi** (rangli fon tinturasi) + **Shoshilinchlik** (sarlavha rang o'zgarishi).
- Aniq holat yorliqlari: "In Progress", "Time-Out", "Ready to Serve" — rangga tayanmasdan.
- Bitta teginish = bajarildi (yoki bildirishnoma yuborish).

**ADIA uchun dars:** Qizil rang faqat haqiqiy kechikish uchun saqlansin. Buyurtma turi (replenishment, production, ta'minot) — alohida fon rangi.

---

## 3. AQSh — MERCHANT BUYURTMALARNI QABUL QILISH (DELIVERY PLATFORMALARI)

### 3.1 Uber Eats Merchant — Order Manager

**Manba:** [Uber Eats Accepting Orders Academy](https://merchants.ubereats.com/us/en/academy/orders/), [Uber Eats Orders App](https://merchants.ubereats.com/us/en/technology/manage-orders/uber-eats-orders-app/)

**Ekran oqimi:**
1. Yangi buyurtma: **tovush signali + yashil chaqnash** — shovqinli muhitda e'tiborga olinadi.
2. Ekranning istalgan joyiga teginish → buyurtma tafsilotlari.
3. "Tasdiqlash" tugmasi → "Bajarilmoqda"ga o'tadi.
4. Chiziqli holat chizig'i: Ko'rish → Tasdiqlash → Bosib chiqarish → Tayyorlash → Topshirish.
5. "Tayyor" tugmasi → kuryer uchun.

**Qurilma moslashuvchanligi:** Uber Eats tomonidan beriladigan planshet yoki xodimlarning shaxsiy telefonlari (bir vaqtda, duplikat yo'q).

**Auto-qabul:** Yoqilgan bo'lsa — yangi buyurtmalar avtomatik tasdiqlanadi, kuryer darhol tayinlanadi.

**Pattern:** Hissiy signal (tovush + vizual) → istalgan joyga tegish → 5-bosqichli chiziq → bajarildi.

---

### 3.2 DoorDash Order Manager — Planshet

**Manba:** [DoorDash Tablet Overview](https://help.doordash.com/en-us/merchants/article/tablet-order-manager-overview), [DoorDash Manage Store on Tablet](https://merchants.doordash.com/en-us/learning-center/managing-your-store-on-your-doordash-tablet), [DoorDash 2025 Real-Time Features](https://about.doordash.com/en-us/news/doordash-empowers-merchants-with-new-real-time-features)

**2025-yil qayta ishlab chiqilgan planshet tajribasi:**
- **Aylantiriluvchi rang kodlangan biletlar:** Buyurtmalarni holat bo'yicha filtrlar va to'liq buyurtma tafsilotlari bilan osonlikcha ko'rib chiqish.
- **"Needs Action" tab:** Diqqatni talab qiladigan buyurtmalar — bu yerda hech narsa o'tkazib yuborilmaydi.
- **Prep vaqti sozlash:** 5-daqiqalik qadamlar bilan yangi, jarayondagi yoki rejalashtirilgan buyurtmalar uchun sozlanadi.
- Kuryer tayinlanmaguncha prep vaqt o'zgartirilishi mumkin.
- **Band soat xususiyati:** Eng band soatlar uchun oldindan prep vaqtini sozlash.
- **Bilet ichidan tezkor harakatlar:** Buyurtmani ko'rish, holat o'zgartirish, prep vaqt yangilash — barchasi bilet kartasidan chiqmasdan.
- **Out-of-stock boshqaruvi:** Yo'q mahsulotlarni tezda belgilash — noto'g'ri buyurtmalarni oldini olish.

**Pattern:** Rang kodlangan karta → yagona "Tasdiqlash" → holat o'zgaradi; ikkinchi darajali harakatlar kontekst bo'yicha paydo bo'ladi.

---

### 3.3 MarketMan, BlueCart, Cut+Dry, Pepper — Ta'minot Buyurtmalari

**Manba:** [MarketMan Restaurant Purchasing](https://www.marketman.com), [BlueCart Wholesale Software](https://www.bluecart.com), [Cut+Dry](https://cutanddry.com), [Pepper UX Leadership Post](https://www.usepepper.com/post/elevating-user-experience-how-peppers-ui-ux-design-leads-the-food-distribution-software-industry)

**MarketMan:**
- Smartfon orqali inventarizatsiya: javon bo'ylab yuring, skanerlang yoki teging, miqdorlar inline.
- Pepper bilan integratsiya — ilovadan chiqmasdan distribyutorga to'g'ridan-to'g'ri buyurtma.
- Pattern: **Skanerlash/tegish = hisoblash; yakunida bitta "Yuborish".**

**BlueCart:**
- Ulgurji oziq-ovqat distribyutorlari va ularning mijozlari uchun onlayn buyurtma tizimi.
- Haqiqiy vaqtda inventarni boshqarish + bir platformada yetkazib beruvchi va xaridor o'rtasida muloqot.
- Mobil ilova — moslashuvchan buyurtma boshqaruvi.

**Cut+Dry:**
- **Tarix = standart:** Eski buyurtmalar bir teginishda "qayta buyurtma qilish" ro'yxatida; AI mahsulot tavsiyalari.
- Buyurtma xatolarini 54% kamaytiradi, vaqtni 50% tejaydi.
- Pattern: **Oxirgi buyurtmani ko'rsating, tahrirlashga ruxsat bering, tasdiqlang.**

**Pepper (usepepper.com, Germaniya/AQSh):**
- AI-kuchli platforma: ovoz, matn, elektron pochta, PDF, fotosuratdan buyurtmalarni avtomatik qayta ishlash.
- 2025-yilda 40% kamroq buyurtma xatosi + 18% yuqori o'rtacha buyurtma qiymati (50+ integratsiya bo'yicha).
- Mobil ilovada kengaytirilgan UX; 2025-yilda Meksika va Buyuk Britaniyaga kengaytirildi.
- Pattern: **Har qanday kanal → bir xil strukturalangan buyurtmaga aylanadi.**

---

## 4. YEVROPA — CHAT-USLUBI BUYURTMALAR VA ENTERPRISE TUZILMALARI

### 4.1 Choco (Germaniya) — Chat Uslubi Buyurtmalar

**Manba:** [Choco US Restaurants](https://choco.com/us/restaurants), [Choco G2 Reviews 2026](https://www.g2.com/products/choco-choco/reviews), [Choco Sales Rep App PR](https://www.prnewswire.com/news-releases/choco-introduces-new-sales-rep-app-for-food-distributors-302282130.html), [Choco App Store](https://apps.apple.com/us/app/choco/id1385672901)

**UI tavsifi:**
- Har bir yetkazib beruvchi = bitta suhbat ipigi (WhatsApp kabi suhbat pufakchalari).
- Buyurtma **3 bosqichda** qo'yiladi: yetkazib beruvchi suhbatini ochish → mahsulotlarni ko'rish/qidirish → tasdiqlash.
- Buyurtma beruvchi tomoni: matnli, ovozli yoki fotosuratli ro'yxat kiritish → AI strukturalangan buyurtma qatorlariga aylantiradi → ko'rib chiqish → tasdiqlash.
- Yetkazib beruvchi tomoni: markazlashtirilgan kiruvchi buyurtma ko'rinishi, "Tasdiqlangan / Tahrir qilinib tasdiqlangan" holat nishonlari.
- AI ovozli pochta buyurtmalarni tinglaydi va hisob-fakturaga aylantiradi → ko'rib chiqing, kerak bo'lsa o'zgartiring, qabul qiling.
- **Natija:** Kunlik buyurtma vaqti ~60 daqiqadan 5-10 daqiqagacha.
- **AI o'zlashtirishi:** Har tuzatishdan o'rganadi; birinchi kundan deyarli aniq. Faqat bir necha kishi biladigan "institutsional bilim" yo'q bo'ladi.

**2023:** Katoo (Ispaniya analog) sotib olindi.

**Pattern:** Ro'yxat-keyin-tasdiqla — suhbat oqimida buyurtma qatorlarini qur; pastda bitta "Yuborish" tugmasi.

---

### 4.2 REKKI (Buyuk Britaniya) — "Faqat Teginish, Yozma Emas"

**Manba:** [REKKI Restaurants](https://rekki.com/restaurants), [REKKI Suppliers](https://rekki.com/suppliers), [Diana Designs Case Study](https://diana-designs.webflow.io/work/rekki), [REKKI Google Play](https://play.google.com/store/apps/details?id=rekkiapp.com.rekki.release)

**Dizayn tarixi va falsafasi:**

Interv'yular: oshpazlar tungi xizmatdan keyin taxminan yarim tunda, juda charchagan holda buyurtma qilishadi. Ko'pincha ona tili ingliz emas. Shu sababli:

- **"Tap instead of type" (Yozing emas, teging):** Imkon qadar ko'proq teginishni afzal ko'ring. Miqdor va hajm vizual katta — noto'g'ri birlik xatosini oldini olish uchun.
- **Har ekranda bitta asosiy harakat:** Oshpaz harakatlar o'rtasida tanlashga majbur bo'lmasligi kerak; faqat bitta asosiy harakat alohida ajralib turadi.
- **WhatsApp metaforasi:** Har bir yetkazib beruvchi = suhbat ipigi. O'qitish nolga tushadi.
- **Yangi yetkazib beruvchi:** Darhol (hisob shaklisiz). Oflayn yetkazib beruvchilarga buyurtmalar avtomatik ravishda elektron pochtaga aylantiriladi.
- **Onboarding:** Yetkazib beruvchini tanlash birinchi navbatda ("wow lahzasi"), keyin buyurtma berish.
- **Buyurtma oqimi:** Suhbatni oching → mahsulotni teging → miqdorni bosing → "Yuborish" → bajarildi.
- Ishlatilmagan xususiyatlar olib tashlandi (ma'lumotlar asosida); asosiy oqim yaxshi ishlaydi deb qaror qilindi va o'zgartirmasdan faqat qayta dizayn qilindi.

**Pattern:** Bitta ustun harakat har ekranda; tanish messenger metaforasi o'qitishni nolga tushiradi.

---

### 4.3 SAP Fiori My Inbox (Germaniya)

**Manba:** [SAP Community: Fiori My Inbox](https://community.sap.com/t5/technology-blog-posts-by-members/fiori-my-inbox-approve-requests-unified-inbox/ba-p/13285425), [SAP Fiori S/4HANA 2025 UX Guide](https://avotechs.com/blog/sap-fiori-for-s4hana-2025-release/)

**Nima qiladi:**
- Barcha tasdiqlash vazifalari (xarid buyurtmasi, ta'til, byudjet) **bitta kirish qutisida** — kafel ko'rinishi; har kafel = bitta kutayotgan vazifa.
- Foydalanuvchilar "asosiy muhitni tushunmasdan" qurilmada bir necha teginishda qaror qabul qilishlari mumkin.
- **Massa harakatlari:** Bir vaqtda bir xil turdagi bir nechta vazifani tasdiqlash.
- **Mobile Start (2025):** Horizon vizual mavzusi — planshet va telefon o'rtasida bir xil ko'rinish, foydalanuvchi qurilmani almashtirsa ham o'zgacha dunyo hissiyoti yo'q.
- **S/4HANA 2026:** My Inbox qaror qilish tezligini oshirishda va operatsion samaradorlikni oshirishda asosiy vosita hisoblanadi.

**Pattern:** Birlashgan kirish qutisi = bitta ro'yxat; vazifani teging → tafsilot + harakat tugmalari; oqimdan tashqariga navigatsiya yo'q.

---

### 4.4 ServiceNow Now Mobile

**Manba:** [ServiceNow Mobile UX Design](https://www.servicenow.com/workflow/mobile-ux-design-business.html), [ServiceNow One-Step Approval](https://www.servicenow.com/community/servicenow-ai-platform-articles/how-to-create-a-one-step-approval-workflow-in-servicenow/ta-p/3445881), [ServiceNow Mobile App Data Sheet](https://www.servicenow.com/standard/resource-center/data-sheet/ds-mobile-app.html)

- So'rovlar, tasdiqlashlar va global qidiruv barmoq uchida.
- **Pastki tab paneli navigatsiyasi faqat** — yon panel yo'q, gorizontal suring yo'q.
- Tez-tez ishlatiladigan harakatlar qadalgan; shakl mantig'i oflaynda munosib ravishda degrades qiladi.
- Yengil mobil yuklamalar; UI va backend'da tekshirilgan kiritishlar.
- 2025 AI yo'nalishi: "Butun enterprise tizimini yo'qoltirishga intilish" — menyular va shakllar o'rniga tabiiy til suhbati.

**Pattern:** Asosiy ma'lumot birinchi; ikkinchi darajali tafsilotlar teginish orqasida; oflayn birinchi.

---

## 5. XITOY — MIQYOS VA CHAT-SAVDO

### 5.1 Meituan Merchant App (美团商家版)

**Manba:** [Meituan Wikipedia](https://en.wikipedia.org/wiki/Meituan), [Meituan Medium Case Study](https://medium.com/design-bootcamp/meituan-and-the-rise-of-the-lifestyle-super-app-can-chinas-ux-model-become-a-global-blueprint-381d385844aa), [Bloomberg AI Agent 2025](https://www.bloomberg.com/news/articles/2025-09-12/meituan-launches-ai-agent-to-boost-food-delivery-business), [Apple App Store Merchant](https://apps.apple.com/us/app/meituan-merchant/id1327175580)

**Miqyos:** 2025-yil iyunida barcha xizmat kategoriyalari bo'yicha kuniga 90 million buyurtma. Dunyodagi eng yirik oziq-ovqat yetkazib berish bozori (550 million+ foydalanuvchi).

**Merchant ilovasi (tadqiqotchining inglizcha manba cheklovlari bilan):**
- Merchant ilova: kupon tekshirish, do'kon dizayn, tavsiya qilish, reklama kabi asosiy funksiyalar hujjatlangan.
- *Ehtimol* (mustaqil tasdiqlash kerak): Yuqori ovozli signal + avtomatik tasdiqlash — g'ayrioddiy band restoran muhiti uchun. Bu pattern Ele.me va Uber Eats merchant ilovalarida mavjud, shuning uchun Meituan ham shu yondashuvni qo'llaydi deb taxmin qilish asosli.
- 2025-yilda Meituan buyurtmalar oqimini optimallashtirish uchun AI agent chiqardi.
- **Ele.me 2025:** Taobao Flash Purchase nomi ostida qayta ishga tushirildi — Alibaba ekotizimiga chuqurroq integratsiya.

**WeChat Mini-Dastur modeli (B2B buyurtma):**
- Restoran QR kodni skanerlaydi → WeChat mini-dastur ochiladi → menyu ko'rsatiladi → ro'yxat tuziladi → "Yuborish" → to'g'ridan-to'g'ri oshxona/POS.
- Mini-dasturlar WeChat Pay bilan to'g'ridan-to'g'ri integratsiyalashgan — to'lov aylanishda qoladi.
- 4.3 million+ mini-dastur, oyiga 945 million foydalanuvchi (2025).
- **B2B buyurtma pattern:** Umumiy WeChat guruhida yetkazib beruvchiga matn: "Ertaga 20 kg un kerak" → yetkazib beruvchi bir teginishda tasdiqlaydi. Bu Choco/REKKI'dan oldin Xitoyda paydo bo'lgan.

---

### 5.2 Hualala (哗啦啦)

**Manba:** [Hualala PitchBook](https://pitchbook.com/profiles/company/268300-90), [MixPay Partnership Medium](https://medium.com/mixpayblog/mixpay-announces-partnership-with-one-of-the-leading-enterprises-among-the-f-b-saas-system-428ce39b5a1b), [Sunami D2s KDS](https://www.sunami.com/seo/2022-02-23/2022-02-23-2.html)

- 2009-yilda tashkil etilgan, Pekin. 400 000+ shartnomali merchant.
- POS + CRM + ERP + katta ma'lumotlar platformasi — to'liq zanjir uchun bir xil tizimda.
- **Ta'minot zanjiri moduli:** R&D, sotib olish, qayta ishlash va sovuq zanjir logistikasi — bir oynada.
- **KDS:** Sunami D2s KDS apparati bilan ishlaydi. Tezkor xizmat va stol xizmatini qo'llab-quvvatlaydi.
- Restoran zanjirlariga bir martalik ta'minot zanjiri xizmatlarini taqdim etadi.

**ADIA uchun ahamiyati:** Bitta kompaniya uchun POS+KDS+ta'minot zanjiri ni birlashtirib amalga oshirgan model — ADIA ERP'ning o'zi maqsad qilayotgan narsadir.

---

### 5.3 Keruyun (客如云)

**Manba:** [Keruyun Official](http://www.keruyun.com/saas-en/basic-efficiency), [PR Newswire Tianfu](https://www.prnewswire.com/news-releases/tianfu-software-park-opening-a-new-era-of-intelligent-restaurant-management-saas-service-by-connecting-people-and-services-300419098.html)

- 2012-yilda tashkil etilgan; 2017-yilda CES'da ishtirok etgan birinchi Xitoylik restoran SaaS kompaniyasi.
- OnPOS — bronlash, olib ketish, to'lov, marketing va ta'minot zanjiri boshqaruvi bitta qurilmada.
- Stol bronlash + onlayn buyurtma + mobil to'lov + avtomatik elektron hisob-faktura.
- Restoran uchun "ishni boshqarish asoslari" — oshxona samaradorligiga e'tibor.

---

### 5.4 Xitoy Modeli: "Chat-Savdo" Pattern

**Manba:** [Sampi.co: WeChat Restaurant Business](https://sampi.co/wechat-app-restaurant-business/), [IT-Consultis B2B WeChat](https://it-consultis.com/insights/b2b-ecommerce-wechat-mini-program-adobe-commerce/), [WalkTheChat 10 Case Studies](https://walkthechat.com/10-wechat-food-beverage-industry-case-studies/)

Xitoyda umumiy B2B buyurtma oqimi:

1. **Guruh chati:** Restoran menedjer yetkazib beruvchi bilan umumiy WeChat guruhida: "100 ta tuxum, 20 kg yog' kerak."
2. **Yetkazib beruvchi tomonida bir teginish:** Tasdiqlash xabari, narx, yetkazib berish vaqti.
3. **Mini-dastur orqali rasmiylashtirish:** Xarid buyurtmasi uchun mini-dastur havolasi.
4. **WeChat Pay to'lov:** Ilovadan chiqmasdan.

Ushbu model — chat-native commerce — Choco va REKKI'dan oldin paydo bo'lgan. Xitoy bozorida chat-uslubi B2B buyurtma texnologiyaga emas, madaniyatga aylangan.

---

## 6. ROSSIYA/MDH — iiko, R_KEEPER, YANDEX.EDA, POSTER

### 6.1 iiko iikoSousChef (Oshxona Ekrani)

**Manba:** [iiko iikoSousChef (resto-s.ru)](https://resto-s.ru/articles/ispolzovanie-kukhonnogo-ekrana-v-iiko-iikosouschef), [iiko help: iikoSousChef konfigurasiya](https://ru.iiko.help/articles/#!iikofront-8-6/iikosouschef1), [iiko Uzbekistan: Zetta Group](https://zetta.uz/ru), [iiko Uzbekistan: A-ONE CORP](https://rest.a-one.uz/), [picktech.ru: iiko vs r_keeper 2026](https://picktech.ru/blog/a-vs-b/iiko-vs-r-keeper-sistema-avtomatizatsii-dlya-restorana-2026/)

**MDH bozorida iiko:**
- Rossiya/MDH bozori lideri.
- Toshkentda ikki rasmiy hamkor: Zetta Group (2015-yildan) va A-ONE CORP.
- **Bulutli arxitektura:** Barcha operatsion ma'lumotlar (savdo, inventar, xodimlar) markaziy saqlash va qurilmalar o'rtasida sinxronizatsiya. Mahalliy server talab qilinmaydi.
- **Sensorli ekran POS:** Katta tugmalar, vizual taom kategoriyalari, tezkor modifikatorlar. Ko'p kassirlar 1-2 smenada ishlay boshlaydi.

**iikoSousChef UI oqimi:**
1. Buyurtma navbatda paydo bo'ladi.
2. Oshpaz "Tayyorlanmoqda 1/2/3/4" bosqimlariga bosadi → vaqtomer boshlanadi.
3. Tayyorlanish muddati normani oshsa → **taom oshpaz va ofitsiant ekranida ajralib ko'rinadi** — shoshilinchlik signali rollar bo'ylab o'tadi.
4. "Tayyor" tugmasi → oshpaz ekranidan yo'qoladi → ofitsiant ekranida paydo bo'ladi.
5. Yig'uvchi yetkazib berish uchun tayyor buyurtmalarni ko'radi → yig'ish + qadoqlashdan keyin kuryerga topshirildi deb belgilaydi.

**Stansiya konfiguratsiyasi:** Har bir terminal faqat o'z stansiyasining mahsulotlarini ko'radi (issiq, sovuq, bar va h.k.).

**Pattern:** Ko'p bosqichli holat bosishlari (kanban taxta emas); rol-spesifik ko'rish; rollar o'rtasida shoshilinchlik ko'rinishi.

---

### 6.2 iikoInventory — Mobil Inventarizatsiya

**Manba:** [iikoInventory Google Play](https://play.google.com/store/apps/details?id=com.iiko.nextinventory), [iiko help: iikoInventory mobil ilova](https://ru.iiko.help/articles/#!iikoweb/iikoinventory-mobile-app)

- Saqlash joyini tanlash va hisoblashni boshlash.
- **O'rnatilgan barcode skaner:** Kamera orqali, qo'shimcha qurilmasiz.
- **Og'irlik tovarlari:** Barkod bo'yicha og'irlik avtomatik kiritiladi.
- Mahsulot tasvirlari mahsulotni aniqlashni osonlashtiradi; **foto-qidiruv** funksiyasi.
- Tizim qancha pozitsiya hisob qilinganini va farqlarni ko'rsatadi.
- **Parolsiz 2 hafta:** Sessiya muddati smenaga moslashtirilgan.
- Bir nechta joyni boshqarish mumkin.

**Pattern:** Oshxona samaradorligiga e'tibor beruvchi tizim uchun mo'ljallangan — skanerlash + hisoblash + farqlar.

---

### 6.3 r_keeper — StoreHouse va KDS

**Manba:** [r_keeper iiko taqqoslash (picktech.ru, 2026)](https://picktech.ru/blog/a-vs-b/iiko-vs-r-keeper-sistema-avtomatizatsii-dlya-restorana-2026/), [r_keeper iiko Poster taqqoslash (rokass.ru, 2026)](https://rokass.ru/blog/iiko-r-keeper-ili-poster-v-2026-kriterii-vybora-sistemy-dlya-avtomatizatsii-kafe-restorana-i-magazin/), [r_keeper Yandex.Eda integratsiya](https://docs.rkeeper.ru/delivery/yandeks-eda-87557916.html)

**r_keeper StoreHouse:**
- MDH mintaqasida **chuqur sklad nazorati uchun etalon** hisoblanadi.
- Ko'p omborli logistika, yarim tayyor mahsulotlar bilan ishlab chiqarish zanjirlari, partiya hisobi.
- Murakkab sadoqat dasturlari va enterprise backend konfiguratsiyasi uchun kuchli.
- Serverga asoslangan arxitektura (30 yillik takomillashtirilgan).

**r_keeper KDS:**
- KDS va VDU monitörlari xizmat chop etishni to'liq almashtirishi yoki u bilan birgalikda ishlatilishi mumkin.
- 2026-yil: KDS "stol aylanishini 15-20% tezlashtiradigan zarur xususiyat" sifatida tavsiflanmoqda.

**Yandex.Eda integratsiya:**
- r_keeper delivery moduli Yandex.Eda bilan integratsiyalashgan.
- Ulanish: `client_id`, `client_secret`, host URL, ob'ekt kodi.
- Birinchi test buyurtmasi kelganda integratsiya avtomatik faollashadi.
- **Yandex.Eda vendor ilovasi (ehtimol):** Buyurtmani qabul qilish, kuryerlarga uzatish, statistika, qo'llab-quvvatlash.

---

### 6.4 Quick Resto (Rossiya) — KDS

**Manba:** [Quick Resto KDS](https://quickresto.ru/kds/)

- Buyurtmalar buyurtmalar va retseptlar ko'rsatiladigan oshxona displey tizimi.
- Oshpazlar o'rtasida avtomatik buyurtma taqsimoti — xatolar kamayadi.
- Android displeylar tavsiya etiladi — moslashuvchan, keng integratsiya.
- Kutish vaqtlarini kamaytiradi, xodimlar muvofiqlashtiruvini yaxshilaydi.

---

### 6.5 Poster POS (Eganing Joriy Tizimi)

**Manba:** [Poster POS Inventory Tour](https://joinposter.com/en/tour/inventory), [Poster POS Mobile](https://joinposter.com/en), [Poster POS iiko alternative](https://joinposter.com/alternative/iiko), [SaaSWorthy Review](https://www.saasworthy.com/product/poster-pos)

Eganing ADIA ERP birgalikda ishlaydigan tizim.

**Inventar va zaxira xususiyatlari:**
- Real vaqtda inventar hisobini kuzatish + moliyaviy oqimlarni monitoring.
- **Kam zaxira ogohlantirishlari:** Zaxira belgilangan minimal darajadan pastga tushganda ogohlantirish.
- **Mobil ilova:** iPad va Android planshetlarda silliq ishlaydi.
- **Samaradorli interfeysga ega:** Haqiqiy vaqt hisobotlari va tahlillar.
- Multikassa/Uzbekistan fiskal integratsiya: Toshkentdagi ADIA egasi bugungi kunda Poster ishlatadi.

**Poster vs iiko:**
- Poster: oddiy, bulutli, past narx → kichik-o'rta restoran va non do'konlari.
- iiko: to'liq ERP klass, murakkab, qimmatroq → katta tarmog'i bo'lgan restoranlar.

**ADIA uchun ahamiyati:** Poster POS xodimlar odatlanib qolgan vizual tildir. ADIA ERP'ning frontline UX'i Poster'ning mobil ohangiga mos kelishi kerak — shuning uchun shu xodimlar yangi tizimni tezda o'zlashtirishadi.

---

## 7. KESIB O'TUVCHI PATTERN'LAR VA TADQIQOT

### 7.1 Non/Ovqat ERP — Bakery-Spesifik Tizimlar

**Manba:** [Wherefour Bakery ERP](https://wherefour.com/bakery-software/), [Cybake Bakery Software](https://cybake.com/), [FlexiBake](https://www.flexibake.com/), [FoodReady Bakery ERP 2026](https://foodready.ai/app/bakery-erp-software/), [Wherefour Best Bakery Software List](https://wherefour.com/best-bakery-software/)

Dunyo bo'ylab non/qandolat uchun maxsus ERP tizimlari:

| Tizim | Asosiy kuch | Inter-bo'lim ish oqimi |
|---|---|---|
| **Wherefour** | Zamonaviy bulutli, buyurtma-asosli ishlab chiqarish rejalashtirish | Buyurtmalar → ishlab chiqarish → inventar oqimi; haqiqiy vaqt ishlab chiqarish holati |
| **Cybake** | Ulgurji + chakana bitta tizimda; buyurtma qabul qilish, ishlab chiqarish, yetkazib berish | **2025-yilda qog'ozsiz ishlab chiqarish ijrosi moduli** chiqdi — qog'oz tizimini bartaraf etish |
| **FlexiBake** | Retsept, inventar, ishlab chiqarish, ulgurji buyurtma bitta platformada | SQF auditi uchun muvofiqlik |
| **Streamline** | Buyurtmalar → ishlab chiqarish → inventar → yetkazib berish → hisob-faktura | Har jamoaga bir xil ma'lumot |

**Cybake 2025 — muhim trend:** Qog'ozsiz lot kuzatuvi va ishlab chiqarish ijrosi moduli — ADIA kabi tizimlar uchun erta raqobatdosh signal.

---

### 7.2 Odoo Barcode Receive — Inline Yetkazilish UX

**Manba:** [Odoo 18 Barcode Receipts/Deliveries](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode/operations/receipts_deliveries.html), [Odoo 19 Barcode Adjustments](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/barcode/operations/adjustments.html)

**Oqim:** Operatsiyalar → Qabul kartasi → O'tkazmani tanlash → Skanerlash/sozlash → Tasdiqlash. 3-4 teginish minimum.

**Inline miqdor sozlash:**
- Qalam belgisi = qo'lda miqdor kiritish.
- "+1 / -1" tugmalari = incremental sozlash.
- Mahsulotni **SCRAP** qilish: nuqsonli deb belgilash → virtual chiqindi joyga ko'chirish.

**Farq bo'linadigan:**
- "Hozir qo'llash" (darhol) va "Ko'rib chiqish uchun kutish" (menejerga belgilash).

**Pattern:** Kutayotgan qabul qilishlar navbati; bir vaqtda bitta qabul qilish; miqdorlarni inline sozlash; bitta Tasdiqlash CTA.

---

### 7.3 Ovozli Buyurtmalar — AI Yo'nalishi

**Manba:** [Loman.ai Voice AI KDS 2025](https://www.loman.ai/blog/voice-ai-and-the-future-of-restaurant-ordering-systems), [BiteBerry AI Voice Ordering Guide 2026](https://biteberry.com/2026/03/06/ai-voice-ordering-for-restaurants-the-complete-2026-guide/), [AppInventiv AI Voice Use Cases](https://appinventiv.com/blog/ai-voice-ordering-in-restaurants/)

**Bozor o'sishi:** Ovozli AI foodtech bozori 2027-yilga kelib $2.5 milliarddan oshadi deb prognoz qilinmoqda (32% yillik o'sish).

**Sanoat namunalari:**
- Wendy's FreshAI (Google Cloud bilan) 2025-yilga kelib 500-600 drive-thru stansiyasiga chiqarildi.
- Choco — ovozli pochta → hisob-fakturaga AI konversiyasi.
- Pepper — ovoz, matn, elektron pochta, PDF, fotosuratdan avtomatik qayta ishlash.

**Texnik model:** Nutq tanish + NLP → kontekstni tushunish + murakkab so'rovlarni qayta ishlash + tranzaksiyalarni bajarish.

**ADIA uchun to'g'ridan-to'g'ri ahamiyati:** Telegram ovozli so'rov (voiceAssistant.ts mavjud) — bu global trend bilan to'g'ri keladi. "10 Napoleon kerak" → strukturalangan replenishment so'roviga.

---

### 7.4 Frontline Worker UX Prinsiplari — Zamonaviy Tadqiqot

**Manba:** [Wednesday.is: Mobile Apps for Frontline Workers Manufacturing 2026](https://mobile.wednesday.is/writing/mobile-apps-frontline-workers-manufacturing-2026), [Stefan Karabin: 7 UX Best Practices Warehouse Mobile Apps](https://medium.com/@stefan.karabin/7-ux-design-best-practices-for-warehouse-mobile-apps-b6e2a0a6940f)

**Teginish maqsadlari:** 56-72 px (standart 44 px o'rniga); qo'lqop bilan mos.

**Holat yorliqlari:** 18-20 px minimal matn.

**Asosiy harakat:** Qaytarib bo'lmaydigan harakatlar uchun teginish + tasdiqlash dialogi (bitta teginish emas).

**Navigatsiya:** Faqat pastki tab paneli; gorizontal suring yo'q.

**Sessiya:** 8-12 soat smenaga uzaytirish (15 daqiqa emas).

**Oflayn birinchi:** Onlayn/oflayn identik xulq-atvor; ishchi hech qachon tarmoq holatini ko'rmaydi.

**Xato xabarlari:** Oddiy til, xato kodlari emas.

**Ombor uchun qo'shimcha:**
- Har skanerlash uchun tovush fikr-mulohaza (bip/ok/xato/muvaffaqiyat) — ko'zlar erkin tasdiqlash.
- Tezkor navigatsiya uchun raqamli menyu yorliqlari — o'qish kerak emas.
- OS navigatsiya panelini yashirish — tasodifiy chiqishni oldini olish.
- Skaner/harakat oqimini bloklamaydigan yumshoq ogohlantirishlar.

---

## 8. 14 TA AMALIY UX QOIDALARI

### Qoida 1 — Bitta Ekran = Bitta Navbat = Bitta Asosiy Tugma
**Manba:** Toast KDS bump, REKKI "bitta ekranda bitta asosiy harakat", KDS case study, Uber Eats "istalgan joyga tegish"

Har rolning standart ekrani — **bitta aylantiriluvchi ro'yxat** kutayotgan vazifalar (kartalar). Har kartada bitta asosiy tugma (Qabul qilish / Bajarildi / Tasdiqlash). Barcha ikkinchi darajali harakatlar (tahrirlash, qisman, rad etish) suring yoki ikkinchi darajali teginish orqali mavjud — standart ko'rinmaydi.

Ko'rsatmang: kanban ustunlari, bir nechta navbat, turli ro'yxatlarga yo'naltiruvchi navigatsiya tablari, ko'rsatmalari bo'lgan bo'sh holatlar.

**ADIA'da qo'llanadi:** Do'kon, sklad, отдел, homashyo — barcha 4 rol standart ko'rinish sifatida "Ishlarim" lentini oladi. Kanban esa faqat PM/Admin va menejer "Batafsil" tabida.

---

### Qoida 2 — Tanish Messenger = Buyurtma Uchun Nol O'qitish
**Manba:** Choco 3-teginish buyurtmasi, REKKI WhatsApp metaforasi, WeChat B2B chat-savdo

Buyurtma yaratish oqimlari shakl kabi emas, chat yoki ketma-ket ro'yxatga o'xshashi kerak. Ishchi mahsulotlarni ro'yxatga teradi yoki bosadi ("10 Napoleon kerak"), ko'rib chiqadi, bitta tugma bilan tasdiqlaydi. Tizim buni strukturalangan yozuvga aylantiradi. Ovoz (Telegram) va terilgan ro'yxat (veb) bir xil kontseptual oqimdir.

"Yozing emas, teging" — imkon qadar matn kiritishni ma'lum mahsulot katalogidan bosish bilan almashtiring.

**ADIA'da qo'llanadi:** Telegram ovozli so'rov allaqachon birinchi darajali. Veb interfeysida "So'rov yuborish" tugmasi chat-uslub ro'yxat ko'rinishida — hisob shakli emas.

---

### Qoida 3 — Rang = Shoshilinchlik + Tur (Ikki O'lchovli, Bitta Emas)
**Manba:** KDS qayta dizayn case study, Toast KDS sarlavha rangi, iiko SousChef me'yor oshishi yorqinligi

Rang kodlashni **ikki mustaqil signal** bilan ishlating:
- **Shoshilinchlik o'qi:** So'rov yaratilganidan beri o'tgan vaqt asosida yashil → sariq → qizil.
- **Tur o'qi:** So'rov turi bo'yicha fon tinti (ishlab chiqarish buyurtmasi, replenishment, ta'minot so'rovi) — shoshilinchlik qizilini tur ko'rsatkichi qizili bilan aralashtirmang.

Hamma joyda qizil bo'lgan dashboardlardan saqlaning (KDS case study ko'rsatdiki, bu xodimlarni falaj qiladi).

**ADIA'da qo'llanadi:** Karta fon tinti = so'rov turi (replenishment=ko'k, ishlab chiqarish=to'q sariq, ta'minot=yashil). Sarlavha rangi o'zgarishi = shoshilinchlik vaqti.

---

### Qoida 4 — Yangi Kiruvchi Ish Uchun Tovush + Chaqnash
**Manba:** Uber Eats yashil chaqnash + tovush, Toast KDS tovush + chaqnash animatsiyasi, iiko SousChef me'yor oshishi rollar o'rtasida, Yandex.Eda ogohlantirishlari

Kiruvchi so'rovlar shovqinli muhitda **e'tiboraliy signal** ishga tushirishi kerak: brauzer bildirishnoma tovushi + sarlavha chaqnashi yoki nishon. Ishchi ekranga qaramasdan yangi vazifani aniqlashi kerak. Web Audio API (brauzer) va Telegram bot push (mobil/oflayn xodimlar uchun) orqali amalga oshiring.

**ADIA'da qo'llanadi:** WebSocket/SSE orqali yangi so'rov → `AudioContext` qisqa bip + sarlavha nishon soni. TG push markaziy sklad menejeriga qo'shiladi.

---

### Qoida 5 — Qabul Qilish Kartasi (To'liq E'tibor)
**Manba:** Uber Eats "istalgan joyga tegish → tasdiqlash", DoorDash buyurtma tafsiloti + bitta Tasdiqlash tugmasi, SAP Fiori tile-to-action

Yangi so'rov rol uchun kelganda (masalan, sklad yetkazib berish so'rovini qabul qilganda; отдел ishlab chiqarish buyurtmasini qabul qilganda), u **asosiy kontent maydonini egallagan katta karta** sifatida taqdim etiladi. Ikkita asosiy tugma: Qabul qilish (yashil, katta) va Rad etish/Yo'naltirish (ikkinchi darajali, kichikroq, sabab talab qiladi). Qabul qilishdan keyin: karta ko'rsatilgan joyda "Bajarilmoqda" holatiga o'tadi — boshqa sahifaga navigatsiya qilmasdan.

**ADIA'da qo'llanadi:** Har qabul qiluvchi rolning lentidagi yangi so'rov — "Qabul qilish/Rad etish" tugmalari to'g'ridan-to'g'ri karta ichida.

---

### Qoida 6 — So'rov Yaratuvchi Uchun Chiziqli Holat Chizig'i
**Manba:** Uber Eats 5-bosqichli chiziq (Ko'rish→Tasdiqlash→Chop etish→Tayyorlash→Topshirish), DoorDash Dasher kuzatuvi, iiko tayyor→ofitsiant ekrani

Har so'rovda uni yaratgan kishi uchun ko'rinadigan **gorizontal holat chizig'i** bo'lsin: masalan, `So'ralgan → Qabul qilindi → Tayyorlanmoqda → Yuborildi → Yopildi`. Chiziq haqiqiy vaqtda avtomatik yangilanadi. So'rovchi hech qaerga navigatsiya qilmaslik kerak — ular o'z lentidagi ("Ishlarim") bir xil kartadagi chiziqni ko'rishadi.

Bu so'rovchilarning kanban'ni tushunishi yoki muntazam tekshirish uchun tafsilot ko'rinishlarini ochish zaruratini yo'q qiladi.

**ADIA'da qo'llanadi:** Do'kon xodimi so'rovini yuboradi → karta lentida qoladi va chiziq o'zgaradi: So'ralgan → Qabul qilindi → Tayyorlanmoqda → Yuborildi.

---

### Qoida 7 — Qisman Bajarish va Brak — Modal Emas, Inline
**Manba:** Odoo "+1/-1 inline sozlash", Odoo SCRAP buyruq, Uber Eats "yo'q narsalarni xabar qilish", ombor QC qisman qabul qilish pattern

Ombor xodimi yoki oshpaz tovarlarni qabul qilganda, ular **bir xil kartada inline** qisman miqdorlar va brak (nuqson) sonini kirita olishi kerak — menejer ko'rib chiqish talab qilmaguncha modal dialog yoki alohida ekran emas. Pattern: har mahsulot qatori `[buyurtma qilingan qty] → [qabul qilingan qty] [brak qty]` +/- stepper tugmalari bilan ko'rsatadi. Barcha qatorlar tasdiqlangandan keyin "Tasdiqlash" tugmasi faollashadi. Agar brak > 0 bo'lsa, tizim menejerni avtomatik belgilaydi lekin ishchini bloklamaydi.

**ADIA'da qo'llanadi:** Do'kon qabul qilish (0045 — mavjud) → markaziy sklad yetkazib berish → xom-ashyo PO qabul qilishgacha kengaytiring.

---

### Qoida 8 — Stansiya Marshrutlash = Rol-Asosli Ko'rish
**Manba:** Toast KDS stansiya marshrutlash, iiko terminal konfiguratsiyasi, SAP Fiori "har rol faqat o'z navbatini ko'radi"

ADIA'dagi har ekran faqat **shu rolning joylashuvi uchun vazifalarni** ko'rsatadi. Do'kon xodimi hech qachon markaziy sklad vazifalarini ko'rmaydi. Отдел oshpazi faqat o'z stansiyasining ishlab chiqarish buyurtmalarini ko'radi. "Batafsil" (to'liq zanjir ko'rinishi) faqat PM/Admin uchun alohida tab ortida.

Bu nafaqat RBAC — bu vizual arxitektura. Agar ekran ishchining o'z vazifalarini topish uchun filtrlash yoki qidirish talab qilsa, u muvaffaqiyatsiz bo'lgan.

**ADIA'da qo'llanadi:** API allaqachon joylashuv asosida RBAC qo'llaydi; UI da buni aks ettirish lozim — "Har qadamda hamma uchun" ko'rinishlar yo'q.

---

### Qoida 9 — Teging, Yozma; Ovoz Birinchi Darajali Kiritish
**Manba:** REKKI "teging, yozma" tamoyili, Choco 3-teginish buyurtmasi, Telegram ovozli buyurtma, AI ovozli buyurtma bozori o'sishi

Operatsion xodimlar uchun klaviatura ishlatishni minimallashtiring. Mahsulotni tanlash = ma'lum ro'yxatdan teging. Miqdor = stepper tugmalar (klaviatura emas). Izohlar/sharhlar = ixtiyoriy. So'rov yaratish uchun: **Telegram orqali ovozli xabar do'kon xodimlari uchun birinchi darajali yo'l**; veb interfeysda ovoz natijasini aks ettiruvchi strukturalangan ro'yxat ko'rsatiladi.

Raqamlar uchun faqat klaviatura kerak; formatlangan ko'rsatuvli katta raqam kiritishni ishlating (mavjud `NumberInput` konventsiyasi).

**ADIA'da qo'llanadi:** Mavjud Telegram ovozli oqim allaqachon birinchi darajali. Veb "So'rov yaratish" — mahsulot tanlash ro'yxati, ixtiyoriy miqdor stepperi, "Yuborish" = 3 qadam.

---

### Qoida 10 — Qaytarib Bo'lmaydigan Harakatlar Teginish + Tasdiq; Teskari Harakatlar Bitta Teginish
**Manba:** Wednesday.is ishlab chiqarish UX qo'llanmasi "qaytarib bo'lmaydigan uchun teginish + tasdiq"; REKKI bitta teginish buyurtmasi

Harakatlarni qaytarilishiga ko'ra tasniflash:
- **Teskari** (bajarilmoqdani belgilash, pishirishni boshlash, tafsilotni ko'rish): bitta teginish.
- **Qaytarib bo'lmaydigan** (qabul qilishni tasdiqlash, jo'natishni tasdiqlash, brakni hisobdan chiqarish): tugmani bosing → oddiy tilidagi tasdiqlash dialogi ("10 kg un qabul qilindi, qaytarib bo'lmaydi. Tasdiqlaysizmi?").
- Miqdor yozuviga hech qachon bitta teginish tasdig'idan foydalanmang. Semiz barmoq himoyasi = brak yarashtirish vaqtingiz.

**ADIA'da qo'llanadi:** `Tasdiqlash` tugmasiga modal: "N ta [mahsulot] jo'natildi. Bu harakat qaytarib bo'lmaydi." Ikkinchi daraja qaytariladigan harakatlar (Boshlash, Ko'rish) — bevosita.

---

### Qoida 11 — Oflayn Birinchi, Smena Uzunligi Sessiyasi
**Manba:** Wednesday.is frontline UX 2026, ServiceNow mobil, DoorDash tarmoq holatini ko'rsatmaslik

Ilova zaif Wi-Fi da ishlashi kerak (non-pishirish muhiti). Kutayotgan harakatlarni mahalliy saqlash; ulanishda sinxronlash. Xodimlar hech qachon "tarmoq xatosi" ko'rmaydi — ular o'z vazifalarini ko'rishadi. Sessiya muddati = smena uzunligi (8-12 soat), standart 30 daqiqa emas.

**ADIA'da qo'llanadi:** Operatsion harakatlar (qabul qilish, brak yozish) uchun localStorage navbat + sinkronlashda qayta yuborish. iikoInventory "2 hafta parolsiz" — muddat miqdori ko'rsatadi.

---

### Qoida 12 — Kanban Faqat Menejer/PM Ko'rinishi
**Manba:** Sintez — yuqoridagi barcha tizimlar operatorlar uchun chiziqli navbatlar, faqat nazoratchilar uchun board ko'rinishlari ishlatadi

Kanban taxta **faqat menejerlar va PM/Admin uchun "Batafsil"** (tafsilot) sifatida saqlanadi. Barcha frontline rollar uchun (do'kon xodimi, sklad xodimi, oshpaz, homashyo omborchi) standart ekran — vertikal karta lenti ("Ishlarim"), taxta emas. Taxta faqat "keyin nima qilishim kerak"ni bilish uchun kimga uchun qiymati yo'q.

**ADIA'da qo'llanadi:** Kanban board frontline marshrutdan olib tashlanadi. PM va menejer uchun "Batafsil" tab boshiga qo'shiladi.

---

### Qoida 13 — Tarix = Standart Takroriy Buyurtmalar Uchun
**Manba:** Cut+Dry "Oxirgi buyurtmani ko'rsating → tahrirlang → tasdiqlang", Choco AI o'rganish, iikoInventory "saqlangan sessiyalar"

Ko'p buyurtmalar takrorlanadi. Standart ko'rinish oxirgi buyurtma/so'rov ro'yxatini ko'rsatsin — foydalanuvchi har safar boshidan boshlashiga majbur qilmang. Mahsulotlarni tanlash sahifasida tez-tez buyurtiladigan narsalar tepada, kamdan-kam ishlatiladiganlar pastda.

**ADIA'da qo'llanadi:** Do'kon xodimi "So'rov yaratish" ekranida — oxirgi 5 so'rovdan miqdorlarni ko'rsating. Bitta tapping — yangi so'rovga nusxa ko'chirish.

---

### Qoida 14 — Eng Ko'p Ishlatiladigan Harakatlar Qadam Bitta
**Manba:** SAP Fiori massa harakatlari, DoorDash bilet ichidan tezkor harakatlar, GoTab smart batching

Kundalik vazifalar (qabul qilish, brak, jo'natish) 3 bosqichdan oshmasligi kerak: Ko'r → Tasdiqlash → Bajarildi. Har harakatdagi ekstra bosqich (sahifaga o'tish, navigatsiya, modal) taxminan 15-20% xodim xatosi va vaqt yo'qotishini qo'shadi. Har UI'ni "bu eng ko'p qilinadigan harakat necha teginish talab qiladi?" deb sinovdan o'tkazing.

**ADIA'da qo'llanadi:** Har rol uchun "asosiy harakat" sinovi: do'kon → "Jo'natildi" tasdiqlash; sklad → "Yetkazildi" tasdiqlash; отдел → "Tayyor" bump.

---

## 9. ROLLAR BO'YICHA BIR EKRAN XARITALASH

### 9.1 Do'kon Xodimi (Dokonchi)

**Standart ekran: "Mening so'rovlarim" (My Requests) — vertikal lent**

| Element | Tafsilot |
|---|---|
| Karta turlari | Har faol/yaqinda bo'lgan so'rov; rangni shoshilinchlik bo'yicha belgilash; inline chiziqli holat chizig'i |
| Asosiy tugma | Birinchi karta "Jo'natildi ni Tasdiqlash" (jo'natma yetganda); inline "Brak kiritish" |
| So'rov yaratish | Pastki o'ng FAB → ovoz (Telegram) yoki ro'yxat terish → tasdiqlash |
| Kanban | Yo'q — faqat "Batafsil" tabida menejer uchun |
| Olib tashlash kerak | Kanban ustunlari, "Kutayotgan Tasdiq" tab, admin ko'rinadigan maydonlar, holat chip terminologiyasi |
| Poster UX analogiyasi | Poster'da "Hisobot" funksiyasi bilan parallel — oddiy, ma'lumot-birinchi |

---

### 9.2 Markaziy Sklad Xodimi

**Standart ekran: "Kiruvchi vazifalar" — KDS-uslubi karta navbati**

| Element | Tafsilot |
|---|---|
| Karta paydo bo'lganda | Do'kon replenishment yuboraganda; отдел ta'minot kerakligida |
| Yangi karta | Tovush + chaqnash. Karta ko'rsatadi: kim so'radi, mahsulot ro'yxati, shoshilinchlik rangi, o'tgan vaqt |
| Asosiy tugmalar | "Qabul qilish" (yashil) → karta "Bajarilmoqda"ga o'tadi; keyin "Jo'natish" → karta yopiladi |
| Qisman | "10 ta'dan 8ni jo'natish" bilan sabab maydoni (tanqislik) — modal emas, inline |
| Menejer ko'rinishi | Avvalgi kabi kanban board — standart emas |
| Nishon/tovush | WebSocket/SSE yangiliklarida brauzer Audio bip + sahifa sarlavha nishoni |

---

### 9.3 Отдел Oshpaz (Ishlab Chiqarish Ustaxonasi)

**Standart ekran: "Bugungi buyurtmalar" — KDS bump navbati**

| Element | Tafsilot |
|---|---|
| Layout | Gorizontal karta chizig'i YOKI vertikal lent (отдел tomonidan konfiguratsiya qilinishi mumkin) |
| Karta tarkibi | Mahsulot nomi (katta), miqdor, shoshilinchlik rangi; boshqa tafsilotlar yo'q |
| Asosiy harakat | "Boshlash" ni bosing → karta vaqtomeri boshlanadi; keyin "Tayyor" → karta bumped off |
| Qisman | "5 ta'dan 3 tasi tayyor" inline stepper → qisman bajarish yoziladi |
| Rollar o'rtasida ogohlantirish | Oshpaz "Tayyor" ni belgilaydi → so'rovchining Ishlarim lenti chizig'i "Tayyor"ga o'tadi |
| "All Day" jadval | Bitta tapping — bugungi barcha buyurtmalar bo'yicha mahsulot jami (Toast modeli) |

---

### 9.4 Homashyo Ombori Xodimi

**Standart ekran: "Qabul qilish" — Odoo-uslubi qabul navbati**

| Element | Tafsilot |
|---|---|
| Ro'yxat | Kutayotgan xarid buyurtmalari / ta'minot so'rovlari |
| Birini bosing | Buyurtma qilingan qty bilan mahsulot qatorlariga kengayadi |
| Inline sozlash | [buyurtma qilingan] → [qabul qilingan stepper] [brak stepper] har qatorda; "+1/-1" tugmalari |
| Tasdiqlash | Barcha qatorlar tegilganda faollashadi. Bosish → tasdiq dialogi (qaytarib bo'lmaydi). |
| Brak > 0 | Menejer uchun yozuvni avtomatik belgilash; ishchini bloklamaydi |
| Barcode | Kamera barkod skaneri (iikoInventory modeli); qo'lda kiritish fallback |

---

## 10. MAVJUD QISMLAR AUDITI

### Bozorga Mos Kelgan Narsalar

| Mavjud Xususiyat | Pattern Mos | Holat |
|---|---|---|
| "Ishlarim" lenti pilot | Q1 (bitta navbat), Q6 (holat chizig'i) | Saqla va kuchaytir — bu to'g'ri model |
| Telegram ovozli buyurtma | Q2 (chat-uslub), Q9 (ovoz-birinchi), AI ovoz trendi | Saqla; do'kon uchun birinchi darajali yaratish yo'li qil |
| So'rov lentida inline Qabul qilish tugmalari | Q5 (Qabul qilish karta pattern) | Saqla; katta teginish maqsadlari (min 56 px) ta'minla |
| NumberInput formatlangan komponent | Q9 (yozma emas), Q10 (raqam kiritish xavfsiz) | Saqla; raqamli kiritish hamma joyda ishlat |
| RBAC joylashuv-asosli ko'rish | Q8 (stansiya marshrutlash) | API darajasida allaqachon; UI'da aks ettir |
| Do'kon brak qabul qilish (0045) | Q7 (inline qisman + brak) | Markaziy sklad va xom-ashyo skladgacha kengaytir |
| Poster POS-dan Sinxronizatsiya | Xodimlar Poster UX tiliga ko'nikkan | ADIA'ning mobil ohangini Poster-ga moslashtir |
| TG bot inline "Qabul qilish" tugmalari | Q5 (katta harakat tugmalari), Q4 (tovush o'rniga push) | TG push: shovqinli muhitda tovush signali |

---

### Frontline Rollardan Yashirish/Olib Tashlash Kerak

| Element | Sabab | Yo'nalish |
|---|---|---|
| Kanban board ustunlari standart sifatida | Hech qanday tizim operatorlar uchun board ishlatmaydi | Menejer/PM "Batafsil" tabiga ko'chir |
| Barcha holatlarni bir vaqtda ko'rsatuvchi ko'p tab navigatsiya | Bitta faol navbat kerak, holat tarixi emas | Bitta faol navbat, "Tarix" ikkinchi darajali tab |
| Ishchi rolga tegishli bo'lmagan shakl maydonlari | Ichki ID, vaqt belgilari, tizim kodlari | Faqat operatsion maydonlarni ko'rsatish |
| Yuqori ko'tariladigan "So'rovlar tarixi" | Hisob-kitob emas, bajarish lenti — birlamchi | Ikkinchi darajali tabga tushir |
| 6-ustunli kanban board standart sifatida | KDS case study: "aktsiyani falaj qiluvchi ko'plab ranglar" | Board saqlanadi lekin chiqib ketish bo'ladi |
| "Kelgan/Chiqgan" toggle | Ombor xodimi bularning ikkalasini ko'rmasligi kerak | Rol-spesifik ko'rinish: Kelgan faqat qabul qiluvchi uchun |
| Holat-atama chiplari | Atama murakkab (Kutuvda/Amalga oshirilmoqda/Muvaffaqiyatli) | Rang + qisqa belgi: So'ralgan/Ketmoqda/Bajarildi |

---

## 11. TOP 3 KEYINGI QADAM

### 1-tavsiya — Barcha Frontline Standart Ekranlarni Karta Lentiga Aylantirish
**Taqir:** YUQORI TAQIR / PAST-O'RTA HARAKATLAR

**Nima:** Kanban-standart ni do'kon, sklad, отдел va homashyo rollari uchun bitta navbatli karta lenti ("Ishlarim") bilan almashtirish. Kanban menejerlar va PM/Admin uchun "Batafsil" tabiga o'tadi.

**Nima uchun:** Tadqiq qilingan har tizim (Choco, REKKI, Toast KDS, Uber Eats, Odoo, SAP Fiori) operatorlar uchun chiziqli vazifa navbati ishlatadi, taxta emas. Bu bitta eng yuqori ROI UX o'zgarishi. Eganing "xuddi chatdek bo'lsin" talabi bilan to'g'ridan-to'g'ri mos keladi.

**Qanday:** "Ishlarim" pilot allaqachon mavjud — rol bo'yicha umumlashtiring. Kanban board ni menejer bo'lmagan rollarga standart marshrutdan olib tashlang; menejerlar uchun sarlavhaga "Batafsil" havolasi qo'shing.

**Kuch:** 3-5 kun frontend; backend allaqachon ma'lumot beradi. Menejerlar hech narsani yo'qotmaydi; ishchilar tomonidagi sarflanishni kamaytiradi.

---

### 2-tavsiya — Kiruvchi So'rovlar Uchun Tovush + Chaqnash Ogohlantirish
**Taqir:** YUQORI TAQIR / PAST HARAKATLAR

**Nima:** Rol uchun yangi so'rov yoki vazifa kelganda (masalan, sklad xodimi replenishment qabul qilganda) qisqa brauzer audio toni ijro etish + lent sarlavhasini chaqnashtirish yoki doimiy nishon ko'rsatish.

**Nima uchun:** Uber Eats "yashil chaqnash + tovush" tarjimalar yo'qotilgan buyurtmalarni oldini oluvchi belgilovchi UX xususiyati sifatida ko'rsatilgan. Non-pishirish oshxonasi ham shunday shovqinli. Audiosiz, ishchi ekranni faol tekshirishi kerak.

**Qanday:** Yangi WebSocket/SSE hodisasida Web Audio API (qisqa bip); sahifa sarlavhasida nishon soni; oflayn/mobil xodimlar uchun Telegram push. Yandex.Eda vendor ilovasi: ogohlantirishlar fix note'da ko'rsatilgan — bu applar bu funksiyani talab qiladi.

**Kuch:** 1-2 kun backend (hodisa chiqarish) + 1 kun frontend.

---

### 3-tavsiya — Har Qabul Ekranida Inline Brak + Qisman Bajarish
**Taqir:** O'RTA TAQIR / O'RTA HARAKATLAR

**Nima:** Har qabul qilish harakati (do'kon qabul qilish, markaziy sklad jo'natma-tasdiq, xom-ashyo PO qabul qilish) har mahsulot uchun inline miqdor tikuvchilarini ko'rsatadi: `[N buyurtma qilingan] → [qabul qilingan __] [brak __]`. Pastda bitta "Tasdiqlash" tugmasi. Brak > 0 menejer uchun belgилайди lekin ishchini bloklamaydi.

**Nima uchun:** Hozirda faqat do'kon brak qabul qilishga ega (migratsiya 0045). Markaziy sklad va xom-ashyo sklad oqimlari yo'q — ma'lumotlar bo'shliqlari hosil qiladi. Odoo "+1/-1 inline, modal emas" sanoat standartidir. Tasdiqlash harakati bo'yicha teginish-tasdiqlash dialogi (Q10) eng keng tarqalgan ombor ma'lumot xatosini oldini oladi.

**Qanday:** Mavjud brak komponent pattern'ini markaziy sklad qabul qilish va PO qabul qilish ekranlariga kengaytiring. Tasdiqlash harakati uchun teginish-tasdiqlash dialogi qo'shing.

**Kuch:** 3-4 kun (backend allaqachon brak maydonlariga ega; mavjud komponentni frontend qayta ishlatish).

---

## 12. MANBALAR

### AQSh — Oshxona Displey Tizimlari
- [Toast KDS Platform Guide](https://doc.toasttab.com/doc/platformguide/platformKDSOverview.html)
- [Toast KDS All Day View](https://support.toasttab.com/en/article/KDS-All-Day-1493055871075)
- [Toast KDS Bump Bar](https://support.toasttab.com/en/article/Use-a-Bump-Bar-With-Toast-KDS)
- [Toast KDS Routing Rules](https://doc.toasttab.com/doc/platformguide/platformKDSWorkflowWithRoutingRules.html)
- [Toast KDS Grid View Overview](https://support.toasttab.com/en/article/Grid-KDS-Overview)
- [Fresh KDS Features](https://www.fresh.technology/kitchen-display-system)
- [Fresh KDS Display Modes](https://www.fresh.technology/blog/kds-display-modes)
- [Fresh KDS 17 Features You Need](https://www.fresh.technology/blog/kitchen-display-system-features-you-need)
- [Fresh KDS Ingredient All Day Counts](https://www.fresh.technology/kds-features/ingredient-all-day-counts)
- [Fresh KDS Item Summary](https://www.fresh.technology/kds-features/item-summary)
- [Fresh KDS Bump Bar Support](https://www.fresh.technology/kds-features/bump-bar-support)
- [Fresh KDS Classic View](https://www.fresh.technology/kds-features/classic-view)
- [Square KDS Android Setup](https://squareup.com/help/us/en/article/7944-get-started-with-square-kds-android)
- [Square KDS Complete Orders](https://squareup.com/help/us/en/article/8171-complete-orders-with-square-kds)
- [Square KDS Product Page](https://squareup.com/us/en/point-of-sale/restaurants/kitchen-display-system)
- [GoTab KDS Products](https://gotab.com/products/kitchen-display-system-kds)
- [GoTab Ultimate KDS Guide 2025](https://gotab.com/latest/the-ultimate-guide-to-kitchen-display-systems-in-2025)
- [GoTab Product Routing](https://gotab.com/features/product-routing)
- [KDS UX Redesign Case Study (Osama Haashir, Medium)](https://medium.com/@osamahaashir/cooking-up-success-revamping-kitchen-display-system-kds-ux-case-study-6a6c92784fb9)
- [Best KDS for Order Routing December 2025 (loman.ai)](https://loman.ai/blog/best-kitchen-display-systems-order-routing)
- [Delivety KDS Guide 2026](https://delivety.com/blog/kitchen-display-system-guide-what-is-a-kds)

### AQSh — Merchant Order Accept
- [Uber Eats Accepting Orders Academy](https://merchants.ubereats.com/us/en/academy/orders/)
- [Uber Eats Orders App](https://merchants.ubereats.com/us/en/technology/manage-orders/uber-eats-orders-app/)
- [Uber Eats Online Order Management](https://merchants.ubereats.com/us/en/technology/manage-orders/overview/)
- [DoorDash Tablet Order Manager Overview](https://help.doordash.com/en-us/merchants/article/tablet-order-manager-overview)
- [DoorDash Managing Store on Tablet](https://merchants.doordash.com/en-us/learning-center/managing-your-store-on-your-doordash-tablet)
- [DoorDash 2025 Real-Time Features](https://about.doordash.com/en-us/news/doordash-empowers-merchants-with-new-real-time-features)
- [DoorDash Receive Orders on Tablet](https://merchants.doordash.com/en-us/learning-center/receive-orders-on-your-doordash-tablet)

### AQSh — Supplier Ordering
- [MarketMan Restaurant Purchasing](https://www.marketman.com/platform/restaurant-purchasing-software-and-order-management)
- [BlueCart Wholesale Software](https://www.bluecart.com/)
- [BlueCart Best Order Management](https://www.bluecart.com/blog/best-order-management-system-food-vendors)
- [Cut+Dry Foodservice E-Commerce](https://cutanddry.com/)
- [Pepper UX Leadership Blog](https://www.usepepper.com/post/elevating-user-experience-how-peppers-ui-ux-design-leads-the-food-distribution-software-industry)
- [Pepper AI Tools 2025](https://www.usepepper.com/post/top-food-distribution-ai-tools)
- [Open Pantry: Best PO Systems for Food Suppliers](https://www.theopenpantry.com/blog/supplier/best-purchase-order-management-systems-food-suppliers)

### Yevropa
- [Choco US Restaurants](https://choco.com/us/restaurants)
- [Choco G2 Reviews 2026](https://www.g2.com/products/choco-choco/reviews)
- [Choco Sales Rep App Press Release](https://www.prnewswire.com/news-releases/choco-introduces-new-sales-rep-app-for-food-distributors-302282130.html)
- [Choco App Store](https://apps.apple.com/us/app/choco/id1385672901)
- [REKKI for Restaurants](https://rekki.com/restaurants)
- [REKKI for Suppliers](https://rekki.com/suppliers)
- [REKKI Design Case Study (Diana Designs)](https://diana-designs.webflow.io/work/rekki)
- [REKKI Google Play](https://play.google.com/store/apps/details?id=rekkiapp.com.rekki.release)
- [Katoo CBInsights (Choco tomonidan sotib olingan)](https://www.cbinsights.com/company/katoo)
- [SAP Fiori My Inbox Unified Inbox (SAP Community)](https://community.sap.com/t5/technology-blog-posts-by-members/fiori-my-inbox-approve-requests-unified-inbox/ba-p/13285425)
- [SAP Fiori S/4HANA 2025 UX Guide (Avotechs)](https://avotechs.com/blog/sap-fiori-for-s4hana-2025-release/)
- [SAP Fiori My Inbox Implementation](https://help.sap.com/docs/SAP_FIORI/d2c296c4f32d4f2a9e3752f58d5ef222/41fd595461fce630e10000000a44538d.html)
- [ServiceNow Mobile UX Design](https://www.servicenow.com/workflow/mobile-ux-design-business.html)
- [ServiceNow One-Step Approval](https://www.servicenow.com/community/servicenow-ai-platform-articles/how-to-create-a-one-step-approval-workflow-in-servicenow/ta-p/3445881)
- [ServiceNow Mobile App Data Sheet](https://www.servicenow.com/standard/resource-center/data-sheet/ds-mobile-app.html)

### Xitoy
- [Meituan Wikipedia](https://en.wikipedia.org/wiki/Meituan)
- [Meituan Medium Super-App Case Study](https://medium.com/design-bootcamp/meituan-and-the-rise-of-the-lifestyle-super-app-can-chinas-ux-model-become-a-global-blueprint-381d385844aa)
- [Meituan AI Agent Bloomberg 2025](https://www.bloomberg.com/news/articles/2025-09-12/meituan-launches-ai-agent-to-boost-food-delivery-business)
- [Meituan Merchant App Store](https://apps.apple.com/us/app/meituan-merchant/id1327175580)
- [Hualala PitchBook](https://pitchbook.com/profiles/company/268300-90)
- [Hualala Crunchbase](https://www.crunchbase.com/organization/hualala)
- [MixPay Hualala Partnership (Medium)](https://medium.com/mixpayblog/mixpay-announces-partnership-with-one-of-the-leading-enterprises-among-the-f-b-saas-system-428ce39b5a1b)
- [Keruyun Official](http://www.keruyun.com/saas-en/basic-efficiency)
- [Keruyun PR Newswire](https://www.prnewswire.com/news-releases/tianfu-software-park-opening-a-new-era-of-intelligent-restaurant-management-saas-service-by-connecting-people-and-services-300419098.html)
- [Sunami D2s KDS](https://www.sunami.com/seo/2022-02-23/2022-02-23-2.html)
- [WeChat Mini-Programs E-Commerce (Digital Creative)](https://digitalcreative.cn/blog/wechat-mini-program-ecommerce-trends-benefits-future)
- [IT-Consultis B2B WeChat Mini Program](https://it-consultis.com/insights/b2b-ecommerce-wechat-mini-program-adobe-commerce/)
- [WalkTheChat 10 WeChat F&B Case Studies](https://walkthechat.com/10-wechat-food-beverage-industry-case-studies/)
- [WeChat Restaurant Business China (Sampi.co)](https://sampi.co/wechat-app-restaurant-business/)
- [Food Supply Chain SaaS Guanmai (EqualOcean)](https://equalocean.com/news/2022052018070)

### Rossiya / MDH
- [iiko iikoSousChef Kitchen Screen (resto-s.ru)](https://resto-s.ru/articles/ispolzovanie-kukhonnogo-ekrana-v-iiko-iikosouschef)
- [iiko iikoSousChef konfigurasiya (iiko help)](https://ru.iiko.help/articles/#!iikofront-8-6/iikosouschef1)
- [iiko Uzbekistan — Zetta Group](https://zetta.uz/ru)
- [iiko Uzbekistan — A-ONE CORP](https://rest.a-one.uz/)
- [iiko vs r_keeper 2026 (picktech.ru)](https://picktech.ru/blog/a-vs-b/iiko-vs-r-keeper-sistema-avtomatizatsii-dlya-restorana-2026/)
- [iiko, r_keeper, Poster 2026 taqqoslash (rokass.ru)](https://rokass.ru/blog/iiko-r-keeper-ili-poster-v-2026-kriterii-vybora-sistemy-dlya-avtomatizatsii-kafe-restorana-i-magazin/)
- [iiko iikoInventory Google Play](https://play.google.com/store/apps/details?id=com.iiko.nextinventory)
- [iiko iikoInventory mobil ilova (iiko help)](https://ru.iiko.help/articles/#!iikoweb/iikoinventory-mobile-app)
- [r_keeper Yandex.Eda integratsiya](https://docs.rkeeper.ru/delivery/yandeks-eda-87557916.html)
- [Quick Resto KDS](https://quickresto.ru/kds/)
- [Yandex.Eda Wikipedia](https://en.wikipedia.org/wiki/Yandex_Eda)
- [Yandex.Eda Vendor Support (Uzbekistan)](https://yandex.com/support/eda-vendor-uz/ru/)
- [Poster POS Inventory Tour](https://joinposter.com/en/tour/inventory)
- [Poster POS iiko alternativi](https://joinposter.com/alternative/iiko)

### Bakery ERP va Frontline UX
- [Wherefour Bakery ERP](https://wherefour.com/bakery-software/)
- [Cybake Bakery Software](https://cybake.com/)
- [FlexiBake ERP](https://www.flexibake.com/)
- [FoodReady Bakery ERP 2026](https://foodready.ai/app/bakery-erp-software/)
- [Wherefour Best Bakery Software](https://wherefour.com/best-bakery-software/)
- [Odoo 18 Barcode Receipts/Deliveries](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode/operations/receipts_deliveries.html)
- [Odoo 19 Barcode Adjustments](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/barcode/operations/adjustments.html)
- [Wednesday.is: Mobile Apps for Frontline Workers Manufacturing 2026](https://mobile.wednesday.is/writing/mobile-apps-frontline-workers-manufacturing-2026)
- [Stefan Karabin: 7 UX Best Practices Warehouse Mobile Apps (Medium)](https://medium.com/@stefan.karabin/7-ux-design-best-practices-for-warehouse-mobile-apps-b6e2a0a6940f)
- [Loman.ai Voice AI Restaurant Ordering 2025](https://www.loman.ai/blog/voice-ai-and-the-future-of-restaurant-ordering-systems)
- [BiteBerry AI Voice Ordering Complete Guide 2026](https://biteberry.com/2026/03/06/ai-voice-ordering-for-restaurants-the-complete-2026-guide/)
- [AppInventiv AI Voice Use Cases](https://appinventiv.com/blog/ai-voice-ordering-in-restaurants/)

---

*Fayl yo'li: `/home/grafeas/WORK/ADIA ERP/docs/references/frontline-ux-patterns-2026-06.md`*
*Oxirgi yangilanish: 2026-06-10 | Tadqiqotchi: market-analyst*
