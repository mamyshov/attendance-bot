const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function checkAuth(req) {
  const pass = req.headers['x-admin-password'];
  return ADMIN_PASSWORD && pass === ADMIN_PASSWORD;
}

// Переводит Date в "местные" компоненты Бишкека (UTC+6) через строковый трюк
function toBishkekParts(date) {
  const s = date.toLocaleString('en-US', { timeZone: 'Asia/Bishkek', hour12: false });
  // s формата "MM/DD/YYYY, HH:mm:ss"
  const d = new Date(s);
  return d;
}

function bishkekDayStartUtc(year, month, day) {
  // Полночь Бишкека (UTC+6) в UTC = вычесть 6 часов
  return new Date(Date.UTC(year, month, day, 0, 0, 0) - 6 * 60 * 60 * 1000);
}

function parseHHMM(str) {
  const [h, m] = (str || '09:00').split(':').map(Number);
  return { h, m };
}

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    res.status(401).json({ error: 'Неверный пароль администратора' });
    return;
  }

  const action = req.query.action;

  try {
    if (action === 'get-qr') {
      const { data, error } = await supabase.from('office').select('qr_secret').eq('id', 1).maybeSingle();
      if (error) throw error;
      res.status(200).json({ qr_secret: data ? data.qr_secret : null });
      return;
    }

    if (action === 'save-qr' && req.method === 'POST') {
      const { qr_secret } = req.body;
      const { data: existing } = await supabase.from('office').select('id').eq('id', 1).maybeSingle();
      if (existing) {
        const { error } = await supabase.from('office').update({ qr_secret }).eq('id', 1);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('office').insert({ id: 1, qr_secret });
        if (error) throw error;
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'employees') {
      const { data, error } = await supabase.from('employees').select('chat_id, name').order('name');
      if (error) throw error;
      res.status(200).json({ employees: data });
      return;
    }

    if (action === 'schedules') {
      const { data, error } = await supabase.from('schedules').select('*');
      if (error) throw error;
      res.status(200).json({ schedules: data });
      return;
    }

    if (action === 'save-schedule' && req.method === 'POST') {
      const { chat_id, work_start, work_end, workdays, grace_minutes } = req.body;
      const { error } = await supabase.from('schedules').upsert({
        chat_id,
        work_start,
        work_end,
        workdays,
        grace_minutes,
      });
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'report') {
      const { from, to, chat_id } = req.query;
      if (!from || !to) {
        res.status(400).json({ error: 'Нужны параметры from и to (YYYY-MM-DD)' });
        return;
      }
      const [fy, fm, fd] = from.split('-').map(Number);
      const [ty, tm, td] = to.split('-').map(Number);
      const startUtc = bishkekDayStartUtc(fy, fm - 1, fd);
      const endUtc = new Date(bishkekDayStartUtc(ty, tm - 1, td).getTime() + 24 * 60 * 60 * 1000);

      let query = supabase
        .from('events')
        .select('*')
        .gte('ts', startUtc.toISOString())
        .lt('ts', endUtc.toISOString())
        .order('ts', { ascending: true });
      if (chat_id) query = query.eq('chat_id', chat_id);

      const { data: events, error } = await query;
      if (error) throw error;

      const { data: schedules } = await supabase.from('schedules').select('*');
      const scheduleByChatId = {};
      (schedules || []).forEach((s) => (scheduleByChatId[s.chat_id] = s));

      // Группируем события по (chat_id, дата по Бишкеку)
      const groups = {};
      for (const e of events) {
        const bDate = toBishkekParts(new Date(e.ts));
        const dateKey = `${bDate.getFullYear()}-${String(bDate.getMonth() + 1).padStart(2, '0')}-${String(
          bDate.getDate()
        ).padStart(2, '0')}`;
        const key = `${e.chat_id}__${dateKey}`;
        if (!groups[key]) {
          groups[key] = { chat_id: e.chat_id, name: e.name, date: dateKey, weekday: bDate.getDay(), events: [] };
        }
        groups[key].events.push(e);
      }

      const rows = Object.values(groups).map((g) => {
        const ins = g.events.filter((e) => e.type === 'in').map((e) => new Date(e.ts));
        const outs = g.events.filter((e) => e.type === 'out').map((e) => new Date(e.ts));
        const firstIn = ins.length ? new Date(Math.min(...ins.map((d) => d.getTime()))) : null;
        const lastOut = outs.length ? new Date(Math.max(...outs.map((d) => d.getTime()))) : null;

        const sched = scheduleByChatId[g.chat_id];
        let lateMinutes = 0;
        let earlyMinutes = 0;
        let scheduledStartStr = '';
        let scheduledEndStr = '';

        if (sched && (sched.workdays || [1, 2, 3, 4, 5]).includes(g.weekday)) {
          const { h: sh, m: sm } = parseHHMM(sched.work_start);
          const { h: eh, m: em } = parseHHMM(sched.work_end);
          scheduledStartStr = sched.work_start;
          scheduledEndStr = sched.work_end;
          const grace = sched.grace_minutes ?? 10;

          if (firstIn) {
            const bIn = toBishkekParts(firstIn);
            const scheduledStartMinutes = sh * 60 + sm + grace;
            const actualMinutes = bIn.getHours() * 60 + bIn.getMinutes();
            lateMinutes = Math.max(0, actualMinutes - scheduledStartMinutes);
          }
          if (lastOut) {
            const bOut = toBishkekParts(lastOut);
            const scheduledEndMinutes = eh * 60 + em;
            const actualMinutes = bOut.getHours() * 60 + bOut.getMinutes();
            earlyMinutes = Math.max(0, scheduledEndMinutes - actualMinutes);
          }
        }

        const workedHours =
          firstIn && lastOut ? Math.round(((lastOut - firstIn) / 3600000) * 100) / 100 : null;

        return {
          date: g.date,
          name: g.name,
          chat_id: g.chat_id,
          firstIn: firstIn
            ? firstIn.toLocaleTimeString('ru-RU', { timeZone: 'Asia/Bishkek', hour: '2-digit', minute: '2-digit' })
            : '',
          lastOut: lastOut
            ? lastOut.toLocaleTimeString('ru-RU', { timeZone: 'Asia/Bishkek', hour: '2-digit', minute: '2-digit' })
            : '',
          scheduledStart: scheduledStartStr,
          scheduledEnd: scheduledEndStr,
          lateMinutes,
          earlyMinutes,
          workedHours,
        };
      });

      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)));

      res.status(200).json({ rows });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    console.error('ADMIN API ERROR:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
