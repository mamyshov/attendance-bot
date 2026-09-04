const { createClient } = require('@supabase/supabase-js');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  try {
    const { device_token, lat, lon } = req.body || {};
    if (!device_token || lat === undefined || lon === undefined) {
      res.status(400).json({ ok: false, message: 'Нужны device_token, lat и lon.' });
      return;
    }

    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('*')
      .eq('device_token', device_token)
      .eq('source', 'app')
      .maybeSingle();

    if (empErr) {
      res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + empErr.message });
      return;
    }
    if (!emp) {
      res.status(401).json({ ok: false, message: 'Неизвестное устройство. Зарегистрируйтесь заново.' });
      return;
    }
    if (emp.device_pending) {
      res.status(200).json({ ok: false, message: 'Ваша заявка ещё ожидает подтверждения администратора.', pending: true });
      return;
    }
    if (!emp.office_id) {
      res.status(200).json({ ok: false, message: 'Администратор ещё не назначил вам филиал.' });
      return;
    }

    const { data: office, error: officeErr } = await supabase
      .from('offices')
      .select('*')
      .eq('id', emp.office_id)
      .maybeSingle();

    if (officeErr || !office) {
      res.status(200).json({ ok: false, message: 'Филиал не найден. Обратитесь к администратору.' });
      return;
    }

    if (emp.is_agent) {
      await supabase
        .from('employees')
        .update({ last_lat: lat, last_lon: lon, last_location_at: new Date().toISOString() })
        .eq('chat_id', emp.chat_id);
    }

    const dist = distanceMeters(office.lat, office.lon, lat, lon);
    const nowInside = dist <= office.radius;
    let changed = false;
    let eventType = null;

    if (nowInside && !emp.inside) {
      await supabase.from('employees').update({ inside: true }).eq('chat_id', emp.chat_id);
      await supabase.from('events').insert({ chat_id: emp.chat_id, name: emp.name, type: 'in' });
      changed = true;
      eventType = 'in';
      const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek' });
      for (const adminId of ADMIN_IDS) {
        try { await tg('sendMessage', { chat_id: adminId, text: `✅ ${emp.name} пришёл(а) — ${t} (${office.name})` }); } catch (e) {}
      }
    } else if (!nowInside && emp.inside) {
      await supabase.from('employees').update({ inside: false }).eq('chat_id', emp.chat_id);
      await supabase.from('events').insert({ chat_id: emp.chat_id, name: emp.name, type: 'out' });
      changed = true;
      eventType = 'out';
      const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek' });
      for (const adminId of ADMIN_IDS) {
        try { await tg('sendMessage', { chat_id: adminId, text: `🚪 ${emp.name} ушёл/ушла — ${t} (${office.name})` }); } catch (e) {}
      }
    }

    res.status(200).json({
      ok: true,
      name: emp.name,
      office: office.name,
      inside: nowInside,
      changed,
      eventType,
      distance: Math.round(dist),
      radius: office.radius,
    });
  } catch (e) {
    console.error('APP-EVENT ERROR:', e);
    res.status(500).json({ ok: false, message: 'Внутренняя ошибка сервера.' });
  }
};
