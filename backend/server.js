require('dotenv').config();
const express    = require('express');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const { Pool }   = require('pg');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Base de datos PostgreSQL ─────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Crear tabla si no existe
pool.query(`
  CREATE TABLE IF NOT EXISTS pedidos (
    id          SERIAL PRIMARY KEY,
    fecha       TEXT    NOT NULL,
    nombre      TEXT    NOT NULL,
    email       TEXT    NOT NULL,
    telefono    TEXT,
    provincia   TEXT,
    direccion   TEXT,
    productos   TEXT    NOT NULL,
    total_usd   REAL    NOT NULL,
    estado      TEXT    NOT NULL DEFAULT 'Pendiente de pago',
    tracking    TEXT,
    notas       TEXT
  )
`).then(() => {
  console.log('✅ Tabla pedidos lista');
}).catch(err => {
  console.error('Error al crear tabla:', err.message);
});

// ── Middlewares ──────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Nodemailer (Gmail) ───────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// ── Helpers ──────────────────────────────────────────────────
function formatearPedidoEmail(items, cliente) {
  const filas = items.map(item =>
    `👟 ${item.brand} ${item.model} — ${item.color} — Talle ${item.size} — $${item.price} USD`
  ).join('\n');

  const total = items.reduce((sum, i) => sum + i.price, 0);

  return `
🛒 NUEVO PEDIDO — GG'SNK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

👤 DATOS DEL CLIENTE
Nombre    : ${cliente.nombre}
Email     : ${cliente.email}
Tel       : ${cliente.telefono || 'No indicado'}
Provincia : ${cliente.provincia || 'No indicada'}
Dirección : ${cliente.direccion || 'No indicada'}

📦 PRODUCTOS
${filas}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💵 TOTAL : $${total} USD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

* Precio en ARS a cotizar al confirmar.
  `;
}

function formatearMensajeWhatsApp(items, cliente) {
  const lineas = items.map((item, i) =>
    `👟 *${item.brand} ${item.model}*\n` +
    `   • Color: ${item.color}\n` +
    `   • Talle: ${item.size} EUR\n` +
    `   • Precio: $${item.price} USD`
  ).join('\n\n');

  const total = items.reduce((sum, i) => sum + i.price, 0);

  return encodeURIComponent(
    `🔥 *NUEVO PEDIDO — GG'SNK*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 *Datos del cliente*\n` +
    `Nombre: ${cliente.nombre}\n` +
    `Provincia: ${cliente.provincia || 'No indicada'}\n\n` +
    `📦 *Productos*\n\n` +
    `${lineas}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 *TOTAL: $${total} USD*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Quedo a la espera para coordinar el pago 🙌`
  );
}

// ── POST /api/pedido ─────────────────────────────────────────
app.post('/api/pedido', async (req, res) => {
  const { items, cliente } = req.body;

  if (!items || items.length === 0)
    return res.status(400).json({ ok: false, error: 'El carrito está vacío.' });
  if (!cliente || !cliente.nombre || !cliente.email)
    return res.status(400).json({ ok: false, error: 'Faltan datos del cliente.' });

  const total = items.reduce((sum, i) => sum + i.price, 0);

  try {
    // 1 — Guardar en base de datos
    const result = await pool.query(
      `INSERT INTO pedidos (fecha, nombre, email, telefono, provincia, direccion, productos, total_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        new Date().toISOString(),
        cliente.nombre,
        cliente.email,
        cliente.telefono  || '',
        cliente.provincia || '',
        cliente.direccion || '',
        JSON.stringify(items),
        total,
      ]
    );
    const pedidoId = result.rows[0].id;

    // 2 — Link WhatsApp
    const waLink = `https://wa.me/${process.env.WHATSAPP_NUMERO}?text=${formatearMensajeWhatsApp(items, cliente)}`;

    // 3 — Responder inmediatamente (no esperamos los emails)
    res.json({ ok: true, whatsappUrl: waLink, pedidoId });

    // 4 — Emails en segundo plano (no bloquean la respuesta)
    transporter.sendMail({
      from   : `"GG'SNK Pedidos" <${process.env.GMAIL_USER}>`,
      to     : process.env.EMAIL_DESTINO,
      subject: `🛒 Nuevo pedido #${pedidoId} — ${cliente.nombre}`,
      text   : `Pedido #${pedidoId}\n` + formatearPedidoEmail(items, cliente),
    }).catch(err => console.error('Error email tienda:', err.message));

    transporter.sendMail({
      from   : `"GG'SNK" <${process.env.GMAIL_USER}>`,
      to     : cliente.email,
      subject: `✅ Recibimos tu pedido #${pedidoId} — GG'SNK`,
      text   : `Hola ${cliente.nombre}!\n\nRecibimos tu pedido y te escribimos en las próximas horas para coordinar el pago.\n\n${formatearPedidoEmail(items, cliente)}\n\n— El equipo de GG'SNK`,
    }).catch(err => console.error('Error email cliente:', err.message));

  } catch (err) {
    console.error('Error al procesar pedido:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo procesar el pedido. Intentá de nuevo.' });
  }
});

// ── GET /api/pedidos — listar todos ─────────────────────────
app.get('/api/pedidos', async (req, res) => {
  try {
    const { estado } = req.query;
    let result;
    if (estado && estado !== 'TODOS') {
      result = await pool.query('SELECT * FROM pedidos WHERE estado = $1 ORDER BY id DESC', [estado]);
    } else {
      result = await pool.query('SELECT * FROM pedidos ORDER BY id DESC');
    }
    const pedidos = result.rows.map(p => ({ ...p, productos: JSON.parse(p.productos) }));
    res.json({ ok: true, pedidos });
  } catch (err) {
    console.error('Error al obtener pedidos:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo obtener los pedidos.' });
  }
});

// ── PUT /api/pedido/:id — actualizar estado y tracking ──────
app.put('/api/pedido/:id', async (req, res) => {
  const { id }                      = req.params;
  const { estado, tracking, notas } = req.body;

  try {
    const check = await pool.query('SELECT id FROM pedidos WHERE id = $1', [id]);
    if (check.rows.length === 0)
      return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });

    await pool.query(
      `UPDATE pedidos SET
        estado   = COALESCE($1, estado),
        tracking = COALESCE($2, tracking),
        notas    = COALESCE($3, notas)
       WHERE id = $4`,
      [estado || null, tracking || null, notas || null, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Error al actualizar pedido:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo actualizar el pedido.' });
  }
});

// ── GET /api/stats — estadísticas para el panel ─────────────
app.get('/api/stats', async (req, res) => {
  try {
    const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows[0]);

    const [total, pendiente, pagado, encargado, camino, entregado, ingresos] = await Promise.all([
      q('SELECT COUNT(*)::int AS n FROM pedidos'),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'Pendiente de pago'"),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'Pagado'"),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'Encargo realizado'"),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'En camino'"),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'Entregado'"),
      q("SELECT COALESCE(SUM(total_usd), 0) AS s FROM pedidos WHERE estado != 'Pendiente de pago'"),
    ]);

    res.json({ ok: true, stats: {
      total:     total.n,
      pendiente: pendiente.n,
      pagado:    pagado.n,
      encargado: encargado.n,
      camino:    camino.n,
      entregado: entregado.n,
      ingresos:  parseFloat(ingresos.s),
    }});
  } catch (err) {
    console.error('Error al obtener stats:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo obtener las estadísticas.' });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ ok: true, mensaje: "GG'SNK backend corriendo 🟢" });
});

// ── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟠 GG'SNK backend corriendo en http://localhost:${PORT}`);
  console.log(`   → POST http://localhost:${PORT}/api/pedido`);
  console.log(`   → GET  http://localhost:${PORT}/api/pedidos`);
  console.log(`   → GET  http://localhost:${PORT}/api/stats`);
  console.log(`   → GET  http://localhost:${PORT}/api/status\n`);
});
