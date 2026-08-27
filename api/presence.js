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

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Тот же алгоритм проверки подлинности initData, что и в checkin.js
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
  if (ageSeconds > 60 * 60 * 24) return null;

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
    const { initData, lat, lon } = req.body || {};
    if (!initData || lat === undefined || lon === undefined) {
      res.status(400).json({ ok: false, message: 'Нет данных геолокации.' });
      return;
    }

    const user = validateInitData(initData);
    if (!user) {
      res.status(401).json({ ok: false, message: 'Не удалось подтвердить, что это открыто из Telegram.' });
      return;
    }

    const chatId = user.id;

    // Автоматическая регистрация по имени из профиля Telegram, если ещё не зарегистрирован
    let { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('*')
      .eq('chat_id', chatId)
      .maybeSingle();

    if (empErr) {
      res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + empErr.message });
      return;
    }

    if (!emp) {
      const autoName = [user.first_name, user.last_name].filter(Boolean).join(' ') || `Пользователь ${chatId}`;
      const { error: upsertErr } = await supabase
        .from('employees')
        .upsert({ chat_id: chatId, name: autoName, inside: false });
      if (upsertErr) {
        res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + upsertErr.message });
        return;
      }
      emp = { chat_id: chatId, name: autoName, inside: false };
    }

    const { data: office, error: officeErr } = await supabase.from('office').select('*').eq('id', 1).maybeSingle();
    if (officeErr || !office) {
      res.status(200).json({ ok: false, message: 'Зона офиса ещё не настроена администратором.', name: emp.name });
      return;
    }

    const dist = distanceMeters(office.lat, office.lon, lat, lon);
    const nowInside = dist <= office.radius;
    let changed = false;
    let eventType = null;

    if (nowInside && !emp.inside) {
      await supabase.from('employees').update({ inside: true }).eq('chat_id', chatId);
      await supabase.from('events').insert({ chat_id: chatId, name: emp.name, type: 'in' });
      changed = true;
      eventType = 'in';
      for (const adminId of ADMIN_IDS) {
        const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek' });
        try { await tg('sendMessage', { chat_id: adminId, text: `✅ ${emp.name} пришёл(а) — ${t}` }); } catch (e) {}
      }
    } else if (!nowInside && emp.inside) {
      await supabase.from('employees').update({ inside: false }).eq('chat_id', chatId);
      await supabase.from('events').insert({ chat_id: chatId, name: emp.name, type: 'out' });
      changed = true;
      eventType = 'out';
      for (const adminId of ADMIN_IDS) {
        const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek' });
        try { await tg('sendMessage', { chat_id: adminId, text: `🚪 ${emp.name} ушёл/ушла — ${t}` }); } catch (e) {}
      }
    }

    res.status(200).json({
      ok: true,
      name: emp.name,
      inside: nowInside,
      changed,
      eventType,
      distance: Math.round(dist),
      radius: office.radius,
    });
  } catch (e) {
    console.error('PRESENCE ERROR:', e);
    res.status(500).json({ ok: false, message: 'Внутренняя ошибка сервера.' });
  }
};
