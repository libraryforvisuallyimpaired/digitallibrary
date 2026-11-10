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
- Quy tắc ghi số liệu trong bảng (rất quan trọng vì kết quả sẽ được đọc to):
  + Mỗi ô số liệu phải đi kèm đơn vị, viết theo thứ tự "số rồi đến đơn vị", ví dụ "2000 triệu người", "23,1%", "450 mm". Không để đơn vị chỉ nằm ở tên cột.
  + Tên cột chỉ là tên mục đo, ví dụ "Dân số", "Lượng mưa", không kèm đơn vị trong tên cột.
  + Viết số nguyên liền nhau, không dùng dấu cách hay dấu chấm ngăn cách hàng nghìn: viết "2000" và "7795", không viết "2 000" hay "7.795".
  + Cột đầu tiên là mốc (năm, tháng, tên nhóm...), ví dụ "1927". Trong "summary" cũng viết số và đơn vị theo cách này.
- Nếu ảnh không phải biểu đồ/sơ đồ/hình học liệu, vẫn mô tả ngắn gọn những gì thấy.`,

  printed: `Bạn là công cụ nhận dạng chữ (OCR) cho học sinh khiếm thị. Hãy đọc toàn bộ chữ in trong ảnh trang sách và chép lại bằng tiếng Việt có dấu, để một phần mềm đọc to sẽ đọc lại.
Quy tắc:
- Chép đúng thứ tự đọc: trang nhiều cột thì đọc hết cột trái rồi sang cột phải; bỏ qua số trang, đầu trang, chân trang nếu không thuộc nội dung.
- Giữ nguyên đoạn văn: mỗi đoạn một dòng, các đoạn cách nhau bằng một dòng trống. Tiêu đề/đề mục để riêng một dòng.
- Công thức, ký hiệu toán học: viết thành lời tiếng Việt để đọc được, ví dụ "a bình phương cộng b bình phương bằng c bình phương", "x lớn hơn hoặc bằng 3".
- Bảng: đọc từng dòng, mỗi dòng một câu dạng "cột 1: giá trị; cột 2: giá trị".
- Số: viết số nguyên liền nhau, không dấu ngăn cách hàng nghìn ("2000" chứ không phải "2.000"); số thập phân dùng dấu phẩy.
- Không thêm bớt, không giải thích, không tóm tắt. Chữ nào không đọc rõ thì ghi [không rõ]. Nếu ảnh không có chữ, trả về text rỗng và đặt "note" giải thích ngắn.`,

  braille: `Bạn là công cụ giải mã chữ Braille 6 chấm nổi tiếng Việt cho học sinh khiếm thị. Làm theo hai bước:
1) Xác định từng ô Braille trong ảnh, theo thứ tự đọc (trái sang phải, trên xuống dưới), chép thành ký tự Unicode Braille (⠁ ⠃ ⠉ ...), ô trống giữa các từ ghi bằng dấu cách. Đưa kết quả vào "cells".
2) Giải mã chuỗi ô đó sang chữ quốc ngữ có dấu theo quy tắc Braille tiếng Việt (có ô dấu thanh, ô dấu số ⠼, ô viết hoa), đưa vào "text". Mỗi dòng Braille là một dòng văn bản.
Quy tắc: không bịa. Ô nào không chắc chắn thì ghi [không rõ] trong "text" và giữ nguyên ô đó trong "cells". Nếu ảnh không có chữ Braille hoặc quá mờ để giải mã, trả về text rỗng và đặt "note" giải thích ngắn lý do. Số viết liền, không dấu ngăn cách hàng nghìn.`,
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
  braille: {
    type: 'OBJECT',
    properties: { cells: { type: 'STRING' }, text: { type: 'STRING' }, note: { type: 'STRING' } },
    required: ['cells', 'text'],
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

  // Danh sách mô hình thử lần lượt: nếu mô hình đầu quá tải (503) hoặc không có (404) thì thử mô hình kế tiếp.
  // Có thể đặt biến GEMINI_MODEL (một hoặc nhiều tên, cách nhau bằng dấu phẩy) để ghi đè.
  const preferred = (process.env.GEMINI_MODEL || '').split(',').map(s => s.trim()).filter(Boolean);
  const models = [...new Set([...preferred, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
  const region = process.env.VERCEL_REGION || 'unknown';
  // Giảm mức "suy nghĩ" của mô hình để trả lời nhanh hơn (tác vụ mô tả ảnh không cần suy luận sâu).
  // Nếu mô hình không hỗ trợ tham số này thì tự thử lại không kèm tham số.
  const buildBody = (withThinking) => JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: PROMPTS[mode] }, { inline_data: { mime_type: mimeType, data: image } }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: mode === 'chart' ? SCHEMAS.chart : mode === 'braille' ? SCHEMAS.braille : SCHEMAS.text,
      ...(withThinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
    },
  });

  const startedAt = Date.now();
  const TOTAL_MS = 56000; // Vercel cắt ở 60 giây (xem vercel.json)
  const failures = [];
  let data = null;
  let withThinking = true;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const remaining = TOTAL_MS - (Date.now() - startedAt);
    if (remaining < 5000) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining - 1000); // dùng hết thời gian còn lại cho lần gọi này
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: buildBody(withThinking),
      });
      if (r.ok) { data = await r.json(); break; }

      let detail = '';
      try { detail = (await r.json())?.error?.message || ''; } catch { /* bỏ qua */ }
      console.log('Gemini error', model, r.status, detail);

      // Mô hình không nhận tham số thinking -> thử lại chính mô hình này, không kèm tham số
      if (r.status === 400 && withThinking && /thinking/i.test(detail)) {
        withThinking = false;
        i--;
        continue;
      }

      failures.push(`${model}: ${r.status} ${detail.slice(0, 120)}`);
      if (r.status === 429) {
        return res.status(429).json({ error: 'Đã hết lượt dùng AI trong hôm nay hoặc đang quá tải. Hãy thử lại sau.' });
      }
      if (![503, 500, 404].includes(r.status)) break; // lỗi khác (khóa sai, vùng bị chặn...) thì dừng, báo luôn
    } catch (err) {
      failures.push(`${model}: ${err && err.name === 'AbortError' ? 'quá thời gian chờ' : (err && err.message)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (!data) {
    return res.status(502).json({
      error: `Dịch vụ AI đang bận hoặc gặp lỗi (vùng ${region}). ${failures.join(' | ').slice(0, 300)}`,
    });
  }

  const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  let result;
  try { result = JSON.parse(raw); } catch { return res.status(502).json({ error: 'AI trả về kết quả không đọc được. Hãy thử lại.' }); }

  return res.status(200).json({ mode, result });
}
