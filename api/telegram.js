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

const LIVE_LOCATION_HINT =
  'Чтобы отметки прихода/ухода шли автоматически, включите в этом чате трансляцию геопозиции:\n' +
  'Скрепка (📎) → Геопозиция → «Трансляция геопозиции» → выберите «Пока не отключу».\n\n' +
  'Этот вариант лучше остальных (15 минут / 1 час) — он не закончится сам, пока вы вручную ' +
  'не остановите трансляцию, поэтому весь рабочий день отметки будут идти автоматически.';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg) {
      res.status(200).send('OK');
      return;
    }

    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text.startsWith('/start')) {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          'Привет! Это табельный бот.\n\n1) Представьтесь: /я Иванов Иван\n\n' +
          '2) Отмечайтесь одним из способов:\n\n' +
          '• Проще всего — кнопка «📍 Отметиться» внизу экрана. Нажимаете её, когда пришли, и ещё раз, когда уходите. ' +
          'Никаких особых разрешений не нужно.\n\n' +
          '• Либо полностью автоматически по геолокации:\n' + LIVE_LOCATION_HINT,
        reply_markup: JSON.stringify({
          keyboard: [[{ text: '📍 Отметиться', request_location: true }]],
          resize_keyboard: true,
          is_persistent: true,
        }),
      });
    } else if (text.startsWith('/presence')) {
      const host = req.headers.host;
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          'Нажмите кнопку ниже, затем «Разрешить геолокацию и начать» на открывшейся странице. ' +
          'Оставьте страницу открытой на экране, пока вы на работе — приход и уход зафиксируются автоматически.',
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: '📍 Открыть автоматическую отметку', web_app: { url: `https://${host}/presence.html` } }]],
        }),
      });
    } else if (text.startsWith('/checkin')) {
      const host = req.headers.host;
      await tg('sendMessage', {
        chat_id: chatId,
        text: 'Нажмите кнопку ниже и наведите камеру на QR-код у входа в офис.',
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: '📷 Отсканировать QR', web_app: { url: `https://${host}/checkin.html` } }]],
        }),
      });
    } else if (text.startsWith('/я')) {
      const name = text.replace('/я', '').trim();
      if (!name) {
        await tg('sendMessage', { chat_id: chatId, text: 'Используйте так: /я Иванов Иван' });
      } else {
        const { error } = await supabase.from('employees').upsert({ chat_id: chatId, name, inside: false });
        if (error) {
          console.error('UPSERT EMPLOYEE ERROR:', JSON.stringify(error));
          await tg('sendMessage', { chat_id: chatId, text: 'Ошибка базы данных: ' + error.message });
        } else {
          await tg('sendMessage', {
            chat_id: chatId,
            text:
              `Записал вас как «${name}».\n\n` +
              'Проще всего отмечаться кнопкой «📍 Отметиться» внизу экрана — нажимайте её при приходе и уходе.\n\n' +
              `Либо можно полностью автоматически:\n${LIVE_LOCATION_HINT}`,
            reply_markup: JSON.stringify({
              keyboard: [[{ text: '📍 Отметиться', request_location: true }]],
              resize_keyboard: true,
              is_persistent: true,
            }),
          });
        }
      }
    } else if (text.startsWith('/zona')) {
      if (!ADMIN_IDS.includes(chatId)) {
        await tg('sendMessage', { chat_id: chatId, text: 'Эта команда только для администратора.' });
      } else {
        const parts = text.split(/\s+/).slice(1);
        if (parts.length !== 3) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'Используйте так: /zona 55.751244 37.618423 150\n(широта, долгота, радиус в метрах)',
          });
        } else {
          const [lat, lon, radius] = parts.map(Number);
          await supabase.from('office').upsert({ id: 1, lat, lon, radius });
          await tg('sendMessage', {
            chat_id: chatId,
            text: `Зона офиса сохранена: ${lat}, ${lon}, радиус ${radius} м.`,
          });
        }
      }
    } else if (text.startsWith('/segodnya')) {
      if (!ADMIN_IDS.includes(chatId)) {
        await tg('sendMessage', { chat_id: chatId, text: 'Эта команда только для администратора.' });
      } else {
        // Определяем "сегодня" по бишкекскому времени (UTC+6), а не по времени сервера
        const bishkekNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bishkek' }));
        const y = bishkekNow.getFullYear();
        const m = bishkekNow.getMonth();
        const d = bishkekNow.getDate();
        // Полночь по Бишкеку = 18:00 UTC предыдущего дня (UTC+6)
        const startOfDayUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 6 * 60 * 60 * 1000);
        const { data, error } = await supabase
          .from('events')
          .select('*')
          .gte('ts', startOfDayUtc.toISOString())
          .order('ts', { ascending: false });
        if (error || !data || !data.length) {
          await tg('sendMessage', { chat_id: chatId, text: 'Сегодня событий пока нет.' });
        } else {
          const lines = data.map((e) => {
            const t = new Date(e.ts).toLocaleTimeString('ru-RU', {
              timeZone: 'Asia/Bishkek',
              hour: '2-digit',
              minute: '2-digit',
            });
            return `${t}  ${e.name}  —  ${e.type === 'in' ? 'Пришёл' : 'Ушёл'}`;
          });
          await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
        }
      }
    } else if (text.startsWith('/export')) {
      if (!ADMIN_IDS.includes(chatId)) {
        await tg('sendMessage', { chat_id: chatId, text: 'Эта команда только для администратора.' });
      } else {
        const args = text.split(/\s+/).slice(1);
        // Аргумент вида 2026-08 (год-месяц). Если не указан — берём текущий месяц по Бишкеку.
        const bishkekNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bishkek' }));
        let year = bishkekNow.getFullYear();
        let month = bishkekNow.getMonth(); // 0-11
        let label = 'этот месяц';

        if (args[0] === 'all') {
          year = null;
        } else if (args[0]) {
          const match = args[0].match(/^(\d{4})-(\d{1,2})$/);
          if (match) {
            year = parseInt(match[1]);
            month = parseInt(match[2]) - 1;
          } else {
            await tg('sendMessage', {
              chat_id: chatId,
              text: 'Формат: /export 2026-08 (год-месяц), или /export all — за всё время.',
            });
            res.status(200).send('OK');
            return;
          }
        }

        let query = supabase.from('events').select('*').order('ts', { ascending: false });
        if (year !== null) {
          const startUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0) - 6 * 60 * 60 * 1000);
          const endUtc = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0) - 6 * 60 * 60 * 1000);
          query = query.gte('ts', startUtc.toISOString()).lt('ts', endUtc.toISOString());
          label = `${String(month + 1).padStart(2, '0')}.${year}`;
        } else {
          label = 'всё время';
        }

        const { data, error } = await query;
        if (error) {
          console.error('EXPORT ERROR:', JSON.stringify(error));
          await tg('sendMessage', { chat_id: chatId, text: 'Ошибка базы данных: ' + error.message });
        } else if (!data || !data.length) {
          await tg('sendMessage', { chat_id: chatId, text: `Нет записей за ${label}.` });
        } else {
          const rows = [['Сотрудник', 'Событие', 'Дата и время (Бишкек)']];
          for (const e of data) {
            const dt = new Date(e.ts).toLocaleString('ru-RU', {
              timeZone: 'Asia/Bishkek',
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            });
            rows.push([e.name, e.type === 'in' ? 'Пришёл' : 'Ушёл', dt]);
          }
          const csv = '\uFEFF' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');

          const form = new FormData();
          form.append('chat_id', String(chatId));
          form.append(
            'document',
            new Blob([csv], { type: 'text/csv' }),
            `attendance_${label.replace(/\./g, '-')}.csv`
          );
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
            method: 'POST',
            body: form,
          });
        }
      }
    } else if (text.startsWith('/help')) {
      if (ADMIN_IDS.includes(chatId)) {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            'Команды администратора:\n' +
            '/zona <широта> <долгота> <радиус_м> — задать зону офиса\n' +
            '/segodnya — журнал за сегодня\n' +
            '/export — выгрузить CSV за текущий месяц\n' +
            '/export 2026-08 — выгрузить CSV за конкретный месяц\n' +
            '/export all — выгрузить CSV за всё время',
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '/я Имя Фамилия — представиться.\nСпособы отметки:\n• Кнопка «📍 Отметиться» внизу экрана\n• /presence — автоматически, пока страница открыта\n• Трансляция геопозиции — полностью автоматически в фоне\n• /checkin — по QR-коду',
        });
      }
    } else if (msg.location) {
      const { data: emp, error: empErr } = await supabase
        .from('employees')
        .select('*')
        .eq('chat_id', chatId)
        .maybeSingle();

      if (empErr) {
        console.error('SELECT EMPLOYEE ERROR:', JSON.stringify(empErr));
        await tg('sendMessage', { chat_id: chatId, text: 'Ошибка базы данных (поиск сотрудника): ' + empErr.message });
      } else if (!emp) {
        await tg('sendMessage', { chat_id: chatId, text: 'Сначала представьтесь: /я Иванов Иван' });
      } else {
        const { data: office, error: officeErr } = await supabase.from('office').select('*').eq('id', 1).maybeSingle();
        if (officeErr) {
          console.error('SELECT OFFICE ERROR:', JSON.stringify(officeErr));
          await tg('sendMessage', { chat_id: chatId, text: 'Ошибка базы данных (поиск зоны): ' + officeErr.message });
          return res.status(200).send('OK');
        }

        if (!office) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'Зона офиса ещё не настроена администратором.',
          });
        } else {
          const isOneTapShare = !msg.location.live_period; // разовое нажатие кнопки, а не постоянная трансляция
          const dist = distanceMeters(
            office.lat,
            office.lon,
            msg.location.latitude,
            msg.location.longitude
          );
          const nowInside = dist <= office.radius;

          if (nowInside && !emp.inside) {
            await supabase.from('employees').update({ inside: true }).eq('chat_id', chatId);
            await supabase.from('events').insert({ chat_id: chatId, name: emp.name, type: 'in' });
            const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek' });
            await tg('sendMessage', { chat_id: chatId, text: `✅ Отмечен приход — ${t}` });
            for (const adminId of ADMIN_IDS) {
              await tg('sendMessage', { chat_id: adminId, text: `✅ ${emp.name} пришёл(а) — ${t}` });
            }
          } else if (!nowInside && emp.inside) {
            await supabase.from('employees').update({ inside: false }).eq('chat_id', chatId);
            await supabase.from('events').insert({ chat_id: chatId, name: emp.name, type: 'out' });
            const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek' });
            await tg('sendMessage', { chat_id: chatId, text: `🚪 Отмечен уход — ${t}` });
            for (const adminId of ADMIN_IDS) {
              await tg('sendMessage', { chat_id: adminId, text: `🚪 ${emp.name} ушёл/ушла — ${t}` });
            }
          } else if (isOneTapShare) {
            // Разовое нажатие кнопки, но статус не поменялся — объясняем, почему
            if (nowInside && emp.inside) {
              await tg('sendMessage', { chat_id: chatId, text: 'Вы уже отмечены как «на месте» — приход уже зафиксирован ранее.' });
            } else if (!nowInside && !emp.inside) {
              await tg('sendMessage', {
                chat_id: chatId,
                text: `Вы вне зоны офиса (примерно ${Math.round(dist)} м от границы) — отметка не засчитана.`,
              });
            }
          }
          // если это непрерывная трансляция и статус не поменялся - молчим, чтобы не спамить
        }
      }
    }
  } catch (e) {
    console.error(e);
  }

  res.status(200).send('OK');
};
