const express = require('express');

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, WEBHOOK_SECRET, COURIER_IDS = '', PORT = 3000 } = process.env;
const COURIERS = COURIER_IDS.split(',').map(s => s.trim()).filter(Boolean);
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB = `${SUPABASE_URL}/rest/v1/orders`;
const H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

const tg = (method, body) =>
  fetch(`${TG}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, ...extra });
const getOrder = async id => (await (await fetch(`${DB}?id=eq.${id}&select=*`, { headers: H })).json())[0];
const setOrder = (id, patch) => fetch(`${DB}?id=eq.${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(patch) });
const isCourier = id => COURIERS.includes(String(id));

async function etaMinutes(a, b) {
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`);
    const j = await r.json();
    return Math.max(1, Math.round(j.routes[0].duration / 60));
  } catch {
    const rad = x => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    const km = 2 * 6371 * Math.asin(Math.sqrt(h));
    return Math.max(1, Math.round((km / 25) * 60));
  }
}

const app = express();
app.use(express.json());
app.get('/', (_, res) => res.send('ok'));
app.post('/webhook/order', async (req, res) => {
  if (req.get('x-secret') !== WEBHOOK_SECRET) return res.sendStatus(401);
  res.sendStatus(200);
  const { record: o, old_record: old } = req.body;
  if (o?.order_status === 'ready' && old?.order_status !== 'ready') {
    if (o.customer_chat_id)
      await send(o.customer_chat_id, `🍽 Buyurtmangiz #${o.id} tayyor bo‘ldi! Tez orada kuryer yo‘lga chiqadi.`);
    for (const c of COURIERS)
      await send(c, `📦 Buyurtma #${o.id} tayyor.`, {
        reply_markup: { inline_keyboard: [[{ text: '🛵 Yo‘lga chiqdim', callback_data: `go:${o.id}` }]] },
      });
  }
});
app.listen(PORT, () => console.log('server on', PORT));

const pending = {};

async function onUpdate(u) {
  const cb = u.callback_query;
  if (cb) {
    const [act, id] = cb.data.split(':');
    const chat = cb.from.id;
    await tg('answerCallbackQuery', { callback_query_id: cb.id });

    if (act === 'go' && isCourier(chat)) {
      pending[chat] = id;
      await send(chat, '📍 Lokatsiyangizni yuboring:', {
        reply_markup: { keyboard: [[{ text: '📍 Lokatsiyani yuborish', request_location: true }]], resize_keyboard: true, one_time_keyboard: true },
      });
    }

    if (act === 'got' && isCourier(chat)) {
      const o = await getOrder(id);
      await setOrder(id, { order_status: 'delivered' });
      await send(chat, `✅ #${id}: mijozga tasdiqlash so‘rovi yuborildi.`);
      if (o?.customer_chat_id)
        await send(o.customer_chat_id, '💵 Kuryer buyurtmani topshirdi. Pulni bergan bo‘lsangiz, tugmani bosing:', {
          reply_markup: { inline_keyboard: [[{ text: '✅ Pul berildi', callback_data: `paid:${id}` }]] },
        });
    }

    if (act === 'paid') {
      const o = await getOrder(id);
      if (o && String(o.customer_chat_id) === String(chat) && o.order_status !== 'paid') {
        await setOrder(id, { order_status: 'paid', paid_at: new Date().toISOString() });
        await send(chat, '🙏 Rahmat! Yoqimli ishtaha.');
      }
    }
  }

  const m = u.message;
  if (m?.location && pending[m.chat.id]) {
    const id = pending[m.chat.id];
    delete pending[m.chat.id];
    const o = await getOrder(id);
    const courier = { lat: m.location.latitude, lng: m.location.longitude };
    const hasDest = o?.customer_lat != null && o?.customer_lng != null;
    const eta = hasDest ? await etaMinutes(courier, { lat: o.customer_lat, lng: o.customer_lng }) : null;

    await setOrder(id, { order_status: 'on_the_way', courier_lat: courier.lat, courier_lng: courier.lng, eta_minutes: eta });
    if (o?.customer_chat_id)
      await send(o.customer_chat_id, eta ? `🛵 Kuryer yo‘lda! Taxminan ${eta} daqiqada keladi.` : '🛵 Kuryer yo‘lda!');

    await send(m.chat.id, `Buyurtma #${id} yo‘lda${eta ? ` (~${eta} daq)` : ''}.`, { reply_markup: { remove_keyboard: true } });
    await send(m.chat.id, 'Mijozga topshirib, pulni olgach bosing:', {
      reply_markup: { inline_keyboard: [[{ text: '💵 Pul olindi', callback_data: `got:${id}` }]] },
    });
  }
}

(async () => {
  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        await onUpdate(u).catch(console.error);
      }
    } catch (e) {
      console.error(e);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
})();
