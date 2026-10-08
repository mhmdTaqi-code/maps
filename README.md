# مسح السايت — الرصافة القديمة

أداة ميدانية لتحليل الموقع بين جسر الشهداء وجسر الأحرار (بغداد): توثيق المباني والدرابين والمسارات بالـ GPS والصور، مع طبقة مباني الحفاظ.

- `index.html`, `app.js`, `app.css` — التطبيق (Leaflet + Geoman + Turf + JSZip، بدون build)
- `data/heritage.geojson` — 80 مبنى حفاظ مستخرجة من المخطط ومُسقطة على الإحداثيات (المحور: المدرسة المستنصرية)
- `data/plan.webp` + `plan_corners.json` — المخطط الأصلي كطبقة فوق الصورة الجوية
- `data/osm_buildings.geojson`, `data/landmarks.geojson` — من OpenStreetMap (ODbL)

البيانات الميدانية تنحفظ على جهاز كل شخص (IndexedDB) وتنتقل بين الفريق بملفات ZIP (تصدير/استيراد مع دمج).
