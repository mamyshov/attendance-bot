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
    if (action === 'offices') {
      const { data, error } = await supabase.from('offices').select('*').order('name');
      if (error) throw error;
      res.status(200).json({ offices: data });
      return;
    }

    if (action === 'save-office' && req.method === 'POST') {
      const { id, name, lat, lon, radius } = req.body;
      if (id) {
        const { error } = await supabase.from('offices').update({ name, lat, lon, radius }).eq('id', id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('offices').insert({ name, lat, lon, radius });
        if (error) throw error;
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'delete-office' && req.method === 'POST') {
      const { id } = req.body;
      const { error } = await supabase.from('offices').delete().eq('id', id);
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'pending-devices') {
      const { data, error } = await supabase
        .from('employees')
        .select('chat_id, name, pending_type, requested_at, office_id')
        .eq('device_pending', true)
        .order('requested_at', { ascending: true });
      if (error) throw error;
      res.status(200).json({ pending: data });
      return;
    }

    if (action === 'approve-device' && req.method === 'POST') {
      const { chat_id, office_id } = req.body;
      const { data: emp, error: findErr } = await supabase
        .from('employees')
        .select('*')
        .eq('chat_id', chat_id)
        .maybeSingle();
      if (findErr) throw findErr;
      if (!emp) {
        res.status(400).json({ error: 'Заявка не найдена' });
        return;
      }

      const update = { device_pending: false, pending_type: null, requested_at: null, office_id };
      if (emp.pending_type === 'relink' && emp.pending_device_token) {
        update.device_token = emp.pending_device_token;
        update.pending_device_token = null;
      }

      const { error } = await supabase.from('employees').update(update).eq('chat_id', chat_id);
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'reject-device' && req.method === 'POST') {
      const { chat_id } = req.body;
      const { data: emp, error: findErr } = await supabase
        .from('employees')
        .select('*')
        .eq('chat_id', chat_id)
        .maybeSingle();
      if (findErr) throw findErr;
      if (!emp) {
        res.status(200).json({ ok: true });
        return;
      }

      if (emp.pending_type === 'register') {
        // Это была первая заявка без подтверждённого устройства — просто удаляем запись
        const { error } = await supabase.from('employees').delete().eq('chat_id', chat_id);
        if (error) throw error;
      } else {
        // Перепривязка отклонена — оставляем старое устройство как было
        const { error } = await supabase
          .from('employees')
          .update({ device_pending: false, pending_type: null, pending_device_token: null, requested_at: null })
          .eq('chat_id', chat_id);
        if (error) throw error;
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'delete-employee' && req.method === 'POST') {
      const { chat_id } = req.body;
      const { error } = await supabase.from('employees').delete().eq('chat_id', chat_id);
      if (error) throw error;
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
      const { chat_id, work_start, work_end, workdays, grace_minutes, schedule_type } = req.body;
      const { error } = await supabase.from('schedules').upsert({
        chat_id,
        work_start,
        work_end,
        workdays,
        grace_minutes,
        schedule_type: schedule_type || 'fixed',
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

      // Берём события с запасом в 3 дня до и после диапазона — чтобы правильно "собрать" смены,
      // которые начались до начала диапазона или ещё не закончились (сутки, ночные смены).
      const bufferStart = new Date(startUtc.getTime() - 3 * 24 * 60 * 60 * 1000);
      const bufferEnd = new Date(endUtc.getTime() + 3 * 24 * 60 * 60 * 1000);

      let query = supabase
        .from('events')
        .select('*')
        .gte('ts', bufferStart.toISOString())
        .lt('ts', bufferEnd.toISOString())
        .order('ts', { ascending: true });
      if (chat_id) query = query.eq('chat_id', chat_id);

      const { data: events, error } = await query;
      if (error) throw error;

      const { data: schedules } = await supabase.from('schedules').select('*');
      const { data: existingEmployees } = await supabase.from('employees').select('chat_id');
      const existingChatIds = new Set((existingEmployees || []).map((e) => String(e.chat_id)));
      const scheduleByChatId = {};
      (schedules || []).forEach((s) => (scheduleByChatId[s.chat_id] = s));

      // Группируем события по сотруднику, затем "склеиваем" в смены: приход -> следующий уход
      const byEmployee = {};
      for (const e of events) {
        if (!byEmployee[e.chat_id]) byEmployee[e.chat_id] = { name: e.name, events: [] };
        byEmployee[e.chat_id].events.push(e);
      }

      const rows = [];
      for (const [empChatId, emp] of Object.entries(byEmployee)) {
        const sched = scheduleByChatId[empChatId];
        const isFixed = sched && sched.schedule_type !== 'flexible';
        const shiftCountByDate = {};

        let openIn = null;
        for (const e of emp.events) {
          if (e.type === 'in') {
            openIn = new Date(e.ts);
          } else if (e.type === 'out') {
            const outTs = new Date(e.ts);
            if (openIn) {
              const dateKey = bishkekDateKey(openIn);
              shiftCountByDate[dateKey] = (shiftCountByDate[dateKey] || 0) + 1;
              const isAdditional = shiftCountByDate[dateKey] > 1;
              rows.push(buildShiftRow(empChatId, emp.name, openIn, outTs, sched, isFixed, isAdditional, !existingChatIds.has(String(empChatId))));
              openIn = null;
            }
            // "уход" без предшествующего "прихода" в пределах буфера — пропускаем (обрезано историей)
          }
        }
        if (openIn) {
          // Смена ещё не закончилась (сотрудник до сих пор на месте на момент запроса)
          const dateKey = bishkekDateKey(openIn);
          shiftCountByDate[dateKey] = (shiftCountByDate[dateKey] || 0) + 1;
          const isAdditional = shiftCountByDate[dateKey] > 1;
          rows.push(buildShiftRow(empChatId, emp.name, openIn, null, sched, isFixed, isAdditional, !existingChatIds.has(String(empChatId))));
        }
      }

      // Оставляем только смены, которые действительно пересекаются с запрошенным диапазоном дат
      const filtered = rows.filter((r) => {
        const shiftStart = r._inRaw;
        const shiftEnd = r._outRaw || bufferEnd;
        return shiftStart < endUtc && shiftEnd >= startUtc;
      });

      filtered.sort((a, b) => b._inRaw - a._inRaw);
      filtered.forEach((r) => { delete r._inRaw; delete r._outRaw; });

      res.status(200).json({ rows: filtered });
      return;
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (e) {
    console.error('ADMIN API ERROR:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};

function bishkekDateKey(date) {
  const b = toBishkekParts(date);
  return `${b.getFullYear()}-${String(b.getMonth() + 1).padStart(2, '0')}-${String(b.getDate()).padStart(2, '0')}`;
}

function buildShiftRow(chatId, name, inTs, outTs, sched, isFixed, isAdditional, isDeleted) {
  const fmtDateTime = (d) =>
    d.toLocaleString('ru-RU', {
      timeZone: 'Asia/Bishkek',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  const CALLOUT_TOLERANCE_MIN = 4 * 60; // 4 часа — за пределами этого окна считаем смену внеплановым вызовом, а не опозданием

  let lateMinutes = 0;
  let earlyMinutes = 0;
  let scheduledStartStr = '';
  let scheduledEndStr = '';
  let scheduleLabel = sched ? (isFixed ? 'фиксированный' : 'гибкий') : '—';
  let isCallout = false;

  if (isFixed && sched && isAdditional) {
    // Это уже вторая (или следующая) смена сотрудника в этот же календарный день —
    // явно дежурство/доп. вызов, а не опоздание на обычную смену. Часы считаем, опоздание — нет.
    scheduleLabel = 'дежурство / доп. смена';
    isCallout = true;
  } else if (isFixed && sched) {
    const bIn = toBishkekParts(inTs);
    const weekday = bIn.getDay();
    const { h: sh, m: sm } = parseHHMM(sched.work_start);
    const { h: eh, m: em } = parseHHMM(sched.work_end);
    const scheduledStartMinutes = sh * 60 + sm;
    const scheduledEndMinutes = eh * 60 + em;
    const actualInMinutes = bIn.getHours() * 60 + bIn.getMinutes();

    // Смена вне обычных рабочих дней ИЛИ начата сильно за пределами обычного окна (например, ночной вызов) —
    // считаем внеплановой: часы считаем как обычно, но опоздание/ранний уход не начисляем.
    const isWorkday = (sched.workdays || [1, 2, 3, 4, 5]).includes(weekday);
    const withinWindow =
      actualInMinutes >= scheduledStartMinutes - CALLOUT_TOLERANCE_MIN &&
      actualInMinutes <= scheduledEndMinutes + CALLOUT_TOLERANCE_MIN;

    if (isWorkday && withinWindow) {
      scheduledStartStr = sched.work_start;
      scheduledEndStr = sched.work_end;
      const grace = sched.grace_minutes ?? 10;
      lateMinutes = Math.max(0, actualInMinutes - (scheduledStartMinutes + grace));

      if (outTs) {
        const bOut = toBishkekParts(outTs);
        const actualOutMinutes = bOut.getHours() * 60 + bOut.getMinutes();
        // ранний уход считаем, только если уход в тот же день, что и приход (иначе это не "ранний уход", а просто долгая смена)
        if (bOut.getDate() === bIn.getDate() && bOut.getMonth() === bIn.getMonth()) {
          earlyMinutes = Math.max(0, scheduledEndMinutes - actualOutMinutes);
        }
      }
    } else {
      isCallout = true;
      scheduleLabel = 'внеплановый вызов';
    }
  }

  const workedHours = outTs ? Math.round(((outTs - inTs) / 3600000) * 100) / 100 : null;

  return {
    chat_id: chatId,
    name,
    isDeleted: !!isDeleted,
    scheduleLabel,
    shiftStart: fmtDateTime(inTs),
    shiftEnd: outTs ? fmtDateTime(outTs) : 'ещё на месте',
    scheduledStart: scheduledStartStr,
    scheduledEnd: scheduledEndStr,
    lateMinutes,
    earlyMinutes,
    workedHours,
    _inRaw: inTs,
    _outRaw: outTs,
  };
}
