# مسح السايت — الرصافة القديمة

أداة ميدانية لتحليل الموقع بين جسر الشهداء وجسر الأحرار (بغداد): توثيق المباني والدرابين والمسارات بالـ GPS والصور، مع طبقة مباني الحفاظ.

- `index.html`, `app.js`, `app.css` — التطبيق (Leaflet + Geoman + Turf + JSZip، بدون build)
- `data/heritage.geojson` — 193 مبنى حفاظ: بصمات مباني حقيقية (Microsoft Building Footprints) مطابقة مع مخطط الحفاظ بمعايرة تلقائية
- `data/buildings.geojson` — باقي مباني السايت (923) قابلة للتوثيق والتصوير
- `data/plan.webp` + `plan_corners.json` — المخطط الأصلي كطبقة فوق الصورة الجوية
- `data/landmarks.geojson` — معالم من OpenStreetMap (ODbL)

البيانات الميدانية تنحفظ على جهاز كل شخص (IndexedDB) وتنتقل بين الفريق بملفات ZIP (تصدير/استيراد مع دمج).
