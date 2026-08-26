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
  'Скрепка (📎) → Геопозиция → «Трансляция геопозиции» → выберите 1 или 8 часов.';

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
          'Привет! Это табельный бот.\n\n1) Представьтесь: /я Иванов Иван\n\n2) ' +
          LIVE_LOCATION_HINT,
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
            text: `Записал вас как «${name}». Теперь: \n\n${LIVE_LOCATION_HINT}`,
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
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const { data, error } = await supabase
          .from('events')
          .select('*')
          .gte('ts', startOfDay.toISOString())
          .order('ts', { ascending: false });
        if (error || !data || !data.length) {
          await tg('sendMessage', { chat_id: chatId, text: 'Сегодня событий пока нет.' });
        } else {
          const lines = data.map((e) => {
            const t = new Date(e.ts).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            });
            return `${t}  ${e.name}  —  ${e.type === 'in' ? 'Пришёл' : 'Ушёл'}`;
          });
          await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
        }
      }
    } else if (text.startsWith('/help')) {
      if (ADMIN_IDS.includes(chatId)) {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            'Команды администратора:\n' +
            '/zona <широта> <долгота> <радиус_м> — задать зону офиса\n' +
            '/segodnya — журнал за сегодня',
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '/я Имя Фамилия — представиться, затем включите трансляцию геопозиции.',
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
            const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            await tg('sendMessage', { chat_id: chatId, text: `✅ Отмечен приход — ${t}` });
            for (const adminId of ADMIN_IDS) {
              await tg('sendMessage', { chat_id: adminId, text: `✅ ${emp.name} пришёл(а) — ${t}` });
            }
          } else if (!nowInside && emp.inside) {
            await supabase.from('employees').update({ inside: false }).eq('chat_id', chatId);
            await supabase.from('events').insert({ chat_id: chatId, name: emp.name, type: 'out' });
            const t = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            await tg('sendMessage', { chat_id: chatId, text: `🚪 Отмечен уход — ${t}` });
            for (const adminId of ADMIN_IDS) {
              await tg('sendMessage', { chat_id: adminId, text: `🚪 ${emp.name} ушёл/ушла — ${t}` });
            }
          }
          // если статус не поменялся - молчим
        }
      }
    }
  } catch (e) {
    console.error(e);
  }

  res.status(200).send('OK');
};
