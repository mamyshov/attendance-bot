const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

async function tg(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}

// Проверка подлинности initData по алгоритму Telegram
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > 60 * 60 * 24) return null; // старше суток — считаем невалидным

  const userJson = params.get('user');
  if (!userJson) return null;
  return JSON.parse(userJson);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  try {
    const { initData, qr_text } = req.body || {};
    if (!initData || !qr_text) {
      res.status(400).json({ ok: false, message: 'Нет данных для проверки.' });
      return;
    }

    const user = validateInitData(initData);
    if (!user) {
      res.status(401).json({ ok: false, message: 'Не удалось подтвердить, что это открыто из Telegram. Попробуйте снова.' });
      return;
    }

    const chatId = user.id;

    const { data: office, error: officeErr } = await supabase.from('office').select('*').eq('id', 1).maybeSingle();
    if (officeErr || !office || !office.qr_secret) {
      res.status(200).json({ ok: false, message: 'QR-код ещё не настроен администратором.' });
      return;
    }

    if (qr_text.trim() !== office.qr_secret.trim()) {
      res.status(200).json({ ok: false, message: 'Это не тот QR-код. Отсканируйте код у входа в офис.' });
      return;
    }

    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('*')
      .eq('chat_id', chatId)
      .maybeSingle();

    if (empErr) {
      res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + empErr.message });
      return;
    }

    if (!emp) {
      res.status(200).json({
        ok: false,
        message: 'Вы ещё не зарегистрированы. Откройте чат с ботом и напишите: /я Имя Фамилия',
      });
      return;
    }

    const nowInside = !emp.inside; // сканирование QR переключает статус: был снаружи -> зашёл, был внутри -> вышел
    const eventType = nowInside ? 'in' : 'out';

    await supabase.from('employees').update({ inside: nowInside }).eq('chat_id', chatId);
    await supabase.from('events').insert({ chat_id: chatId, name: emp.name, type: eventType });

    const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek' });
    const employeeMessage =
      eventType === 'in' ? `✅ Отмечен приход — ${t} (по QR)` : `🚪 Отмечен уход — ${t} (по QR)`;
    const adminMessage =
      eventType === 'in' ? `✅ ${emp.name} пришёл(а) — ${t} (по QR)` : `🚪 ${emp.name} ушёл/ушла — ${t} (по QR)`;

    for (const adminId of ADMIN_IDS) {
      try {
        await tg('sendMessage', { chat_id: adminId, text: adminMessage });
      } catch (e) {
        /* ignore */
      }
    }

    res.status(200).json({ ok: true, message: employeeMessage });
  } catch (e) {
    console.error('CHECKIN ERROR:', e);
    res.status(500).json({ ok: false, message: 'Внутренняя ошибка сервера.' });
  }
};
