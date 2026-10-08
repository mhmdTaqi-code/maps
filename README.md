# مسح السايت — الرصافة القديمة

أداة ميدانية لتحليل الموقع بين جسر الشهداء وجسر الأحرار (بغداد): توثيق المباني والدرابين والمسارات بالـ GPS والصور، مع طبقة مباني الحفاظ.

- `index.html`, `app.js`, `app.css` — التطبيق (Leaflet + Geoman + Turf + JSZip، بدون build)
- `data/heritage.geojson`, `data/buildings.geojson` — كل مبنى بحدوده من رسم المخطط (138 مبنى حفاظ + 868 مبنى، الحوش فراغ داخلي)
- `data/streets.geojson` — شبكة الشوارع والدرابين: مساحة الشارع + محاور بالعرض والنوع والاسم (من OSM)
- `tools/vectorize_plan.py` — يولّد الطبقات أعلاه من `data/plan.webp`، والإسقاط الجغرافي من `tools/fit.json` (معايرة على بصمات المباني والصورة الجوية). نتيجة الفحص: `tools/check_vectorize.png`
- `data/cad_*.geojson`, `data/context_buildings.geojson` — من ملف CADMapper (DXF): مباني المحيط بارتفاعاتها، حواف الشوارع، النهر، الكنتور. التحويل `tools/dxf_to_geojson.py` (كتبه gpt-6-astra عبر Codex)، والإسقاط `tools/cad_georef.json` (مطابقة 91% مع مباني OSM)، والدمج `tools/attach_cad.py`. ارتفاع 3.0 م بملف CADMapper قيمة افتراضية = غير معروف.
- `data/plan.webp` + `plan_corners.json` — المخطط الأصلي كطبقة فوق الصورة الجوية
- `data/landmarks.geojson` — معالم من OpenStreetMap (ODbL)

البيانات الميدانية تنحفظ على جهاز كل شخص (IndexedDB) وتنتقل بين الفريق بملفات ZIP (تصدير/استيراد مع دمج).
