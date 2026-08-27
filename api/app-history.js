const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  try {
    const { device_token } = req.body || {};
    if (!device_token) {
      res.status(400).json({ ok: false, message: 'Нужен device_token.' });
      return;
    }

    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('chat_id, name, device_pending')
      .eq('device_token', device_token)
      .eq('source', 'app')
      .maybeSingle();

    if (empErr) {
      res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + empErr.message });
      return;
    }
    if (!emp) {
      res.status(401).json({ ok: false, message: 'Неизвестное устройство.' });
      return;
    }

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const { data: events, error: evErr } = await supabase
      .from('events')
      .select('type, ts')
      .eq('chat_id', emp.chat_id)
      .gte('ts', since.toISOString())
      .order('ts', { ascending: false });

    if (evErr) {
      res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + evErr.message });
      return;
    }

    const items = (events || []).map((e) => ({
      type: e.type,
      date: new Date(e.ts).toLocaleDateString('ru-RU', { timeZone: 'Asia/Bishkek' }),
      time: new Date(e.ts).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Bishkek', hour: '2-digit', minute: '2-digit' }),
    }));

    res.status(200).json({ ok: true, name: emp.name, events: items });
  } catch (e) {
    console.error('APP-HISTORY ERROR:', e);
    res.status(500).json({ ok: false, message: 'Внутренняя ошибка сервера.' });
  }
};
