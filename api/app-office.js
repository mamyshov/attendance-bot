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
      .select('*')
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
    if (emp.device_pending) {
      res.status(200).json({ ok: false, message: 'Заявка ещё ожидает подтверждения.', pending: true });
      return;
    }
    if (!emp.office_id) {
      res.status(200).json({ ok: false, message: 'Администратор ещё не назначил филиал.' });
      return;
    }

    const { data: office, error: officeErr } = await supabase
      .from('offices')
      .select('*')
      .eq('id', emp.office_id)
      .maybeSingle();

    if (officeErr || !office) {
      res.status(200).json({ ok: false, message: 'Филиал не найден.' });
      return;
    }

    res.status(200).json({
      ok: true,
      office: { name: office.name, lat: office.lat, lon: office.lon, radius: office.radius },
    });
  } catch (e) {
    console.error('APP-OFFICE ERROR:', e);
    res.status(500).json({ ok: false, message: 'Внутренняя ошибка сервера.' });
  }
};
