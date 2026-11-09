// Vercel Serverless Function: máy chủ trung gian giữa trang web và Gemini.
// Chạy ở vùng Mỹ (xem vercel.json) vì Gemini API không phục vụ một số khu vực (Hồng Kông, ...).
// Biến môi trường (Vercel > Project > Settings > Environment Variables):
//   GEMINI_API_KEY   (bắt buộc)  khóa Gemini
//   ALLOWED_ORIGINS  (nên có)    vd: https://libraryforvisuallyimpaired.github.io  (nhiều tên miền: cách nhau bằng dấu phẩy)
//   GEMINI_MODEL     (tùy chọn)  mặc định gemini-3.8-flash

const MAX_IMAGE_BASE64_CHARS = 4_000_000; // Vercel giới hạn thân yêu cầu ~4,5 MB
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const PROMPTS = {
  chart: `Bạn là trợ lý giáo dục cho học sinh khiếm thị Việt Nam. Hãy mô tả hình ảnh (biểu đồ, sơ đồ, bản đồ hoặc hình minh họa trong sách giáo khoa) bằng tiếng Việt, đúng chuẩn sư phạm, để người không nhìn thấy hình vẫn hiểu được.
Quy tắc:
- Chỉ nêu những gì thật sự thấy trong ảnh. Không bịa số liệu. Nếu số liệu không đọc rõ, hãy nói rõ là không đọc rõ.
- "title": tên biểu đồ/hình (ngắn gọn).
- "summary": 2-4 câu tóm tắt loại hình, nội dung chính và xu hướng nổi bật.
- "table": biểu diễn dữ liệu chi tiết thành bảng. "headers" là tên các cột, "rows" là các dòng (mỗi ô là một chuỗi). Nếu hình không có số liệu (ví dụ sơ đồ quá trình), dùng bảng 2 cột "Thành phần" và "Mô tả". Tối đa 8 cột, 20 dòng.
- "pedagogy": 1-2 câu ghi chú giúp học sinh hiểu và ghi nhớ.
- Viết số thập phân bằng dấu phẩy theo cách viết tiếng Việt.
- Nếu ảnh không phải biểu đồ/sơ đồ/hình học liệu, vẫn mô tả ngắn gọn những gì thấy.`,

  printed: `Bạn là công cụ nhận dạng chữ (OCR) cho học sinh khiếm thị. Hãy đọc toàn bộ chữ in trong ảnh trang sách và chép lại bằng tiếng Việt có dấu, theo đúng thứ tự đọc, giữ nguyên đoạn văn.
Quy tắc: không thêm bớt, không giải thích. Chữ nào không đọc rõ thì ghi [không rõ]. Nếu ảnh không có chữ, trả về text rỗng và đặt "note" giải thích ngắn.`,

  braille: `Bạn là công cụ giải mã chữ Braille 6 chấm nổi tiếng Việt cho học sinh khiếm thị. Hãy xác định các ô Braille trong ảnh và giải mã sang chữ quốc ngữ có dấu, theo thứ tự đọc.
Quy tắc: không bịa. Ô nào không chắc chắn thì ghi [không rõ]. Nếu ảnh không có chữ Braille hoặc quá mờ để giải mã, trả về text rỗng và đặt "note" giải thích ngắn lý do.`,
};

const SCHEMAS = {
  chart: {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      summary: { type: 'STRING' },
      table: {
        type: 'OBJECT',
        properties: {
          headers: { type: 'ARRAY', items: { type: 'STRING' } },
          rows: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } } },
        },
        required: ['headers', 'rows'],
      },
      pedagogy: { type: 'STRING' },
    },
    required: ['title', 'summary', 'table', 'pedagogy'],
  },
  text: {
    type: 'OBJECT',
    properties: { text: { type: 'STRING' }, note: { type: 'STRING' } },
    required: ['text'],
  },
};

export default async function handler(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const origin = req.headers.origin || '';
  const originOk = allowed.length === 0 || allowed.includes(origin);

  res.setHeader('Access-Control-Allow-Origin', originOk ? (allowed.length === 0 ? '*' : origin) : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Chỉ hỗ trợ POST.' });
  if (!originOk) return res.status(403).json({ error: 'Tên miền này không được phép gọi dịch vụ.' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Máy chủ chưa được cấu hình khóa API.' });

  const { image, mimeType, mode } = req.body || {};
  if (!PROMPTS[mode]) return res.status(400).json({ error: 'Chế độ không hợp lệ.' });
  if (typeof image !== 'string' || !image) return res.status(400).json({ error: 'Thiếu hình ảnh.' });
  if (!ALLOWED_MIME.includes(mimeType)) return res.status(400).json({ error: 'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.' });
  if (image.length > MAX_IMAGE_BASE64_CHARS) return res.status(413).json({ error: 'Ảnh quá lớn. Hãy chọn ảnh nhỏ hơn.' });

  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPTS[mode] }, { inline_data: { mime_type: mimeType, data: image } }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: mode === 'chart' ? SCHEMAS.chart : SCHEMAS.text,
        },
      }),
    });
  } catch {
    return res.status(502).json({ error: 'Không kết nối được tới dịch vụ AI.' });
  }

  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json())?.error?.message || ''; } catch { /* bỏ qua */ }
    console.log('Gemini error', r.status, detail);
    if (r.status === 429) return res.status(429).json({ error: 'Đã hết lượt dùng AI trong hôm nay hoặc đang quá tải. Hãy thử lại sau.' });
    return res.status(502).json({ error: `Dịch vụ AI trả về lỗi (${r.status}): ${detail.slice(0, 200) || 'không rõ nguyên nhân'}` });
  }

  const data = await r.json();
  const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  let result;
  try { result = JSON.parse(raw); } catch { return res.status(502).json({ error: 'AI trả về kết quả không đọc được. Hãy thử lại.' }); }

  return res.status(200).json({ mode, result });
}
