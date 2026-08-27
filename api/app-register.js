const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function generateAppChatId() {
  // Отрицательное число гарантированно не пересекается с настоящими Telegram user id (всегда положительные)
  const rand = Math.floor(Math.random() * 1e12) + 1;
  return -rand;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }

  try {
    const { name, mode } = req.body || {};
    const cleanName = (name || '').trim();
    if (!cleanName || !['register', 'relink'].includes(mode)) {
      res.status(400).json({ ok: false, message: 'Нужны имя и режим (register/relink).' });
      return;
    }

    if (mode === 'register') {
      // Проверяем, нет ли уже подтверждённого сотрудника с таким именем из приложения
      const { data: existing } = await supabase
        .from('employees')
        .select('chat_id, device_pending')
        .eq('source', 'app')
        .ilike('name', cleanName)
        .maybeSingle();

      if (existing && !existing.device_pending) {
        res.status(200).json({
          ok: false,
          message: 'Сотрудник с таким именем уже зарегистрирован. Если это вы и у вас новый телефон — используйте "Восстановить доступ".',
        });
        return;
      }
      if (existing && existing.device_pending) {
        res.status(200).json({
          ok: false,
          message: 'Заявка с этим именем уже отправлена и ожидает подтверждения администратора.',
        });
        return;
      }

      const chatId = generateAppChatId();
      const token = generateToken();

      const { error } = await supabase.from('employees').insert({
        chat_id: chatId,
        name: cleanName,
        inside: false,
        source: 'app',
        device_token: token,
        device_pending: true,
        pending_type: 'register',
        requested_at: new Date().toISOString(),
      });

      if (error) {
        res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + error.message });
        return;
      }

      res.status(200).json({
        ok: true,
        device_token: token,
        message: 'Заявка отправлена. Дождитесь подтверждения администратора — после этого приложение начнёт работать.',
      });
      return;
    }

    if (mode === 'relink') {
      const { data: existing, error: findErr } = await supabase
        .from('employees')
        .select('*')
        .eq('source', 'app')
        .ilike('name', cleanName)
        .maybeSingle();

      if (findErr) {
        res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + findErr.message });
        return;
      }
      if (!existing) {
        res.status(200).json({
          ok: false,
          message: 'Сотрудник с таким именем не найден. Если вы ещё не регистрировались — используйте обычную регистрацию.',
        });
        return;
      }

      const newToken = generateToken();
      const { error: updateErr } = await supabase
        .from('employees')
        .update({
          pending_device_token: newToken,
          device_pending: true,
          pending_type: 'relink',
          requested_at: new Date().toISOString(),
        })
        .eq('chat_id', existing.chat_id);

      if (updateErr) {
        res.status(200).json({ ok: false, message: 'Ошибка базы данных: ' + updateErr.message });
        return;
      }

      res.status(200).json({
        ok: true,
        device_token: newToken,
        message: 'Заявка на новое устройство отправлена. После подтверждения администратором старое устройство перестанет работать, а это — начнёт.',
      });
      return;
    }
  } catch (e) {
    console.error('APP-REGISTER ERROR:', e);
    res.status(500).json({ ok: false, message: 'Внутренняя ошибка сервера.' });
  }
};
