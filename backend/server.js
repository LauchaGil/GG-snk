require('dotenv').config();
const express    = require('express');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const Database   = require('better-sqlite3');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Base de datos SQLite ─────────────────────────────────────
const db = new Database(path.join(__dirname, 'pedidos.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS pedidos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
`);

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
  const lineas = items.map(item =>
    `- ${item.brand} ${item.model} | ${item.color} | Talle ${item.size} | $${item.price} USD`
  ).join('\n');

  const total = items.reduce((sum, i) => sum + i.price, 0);

  return encodeURIComponent(
    `Hola! Quiero hacer un pedido en GG'SNK\n\n` +
    `Nombre: ${cliente.nombre}\n\n` +
    `Productos:\n${lineas}\n\n` +
    `Total: $${total} USD\n\n` +
    `Quedo a la espera para coordinar el pago`
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
    const insert = db.prepare(`
      INSERT INTO pedidos (fecha, nombre, email, telefono, provincia, direccion, productos, total_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(
      new Date().toISOString(),
      cliente.nombre,
      cliente.email,
      cliente.telefono  || '',
      cliente.provincia || '',
      cliente.direccion || '',
      JSON.stringify(items),
      total
    );

    // 2 — Email a la tienda
    await transporter.sendMail({
      from   : `"GG'SNK Pedidos" <${process.env.GMAIL_USER}>`,
      to     : process.env.EMAIL_DESTINO,
      subject: `🛒 Nuevo pedido #${result.lastInsertRowid} — ${cliente.nombre}`,
      text   : `Pedido #${result.lastInsertRowid}\n` + formatearPedidoEmail(items, cliente),
    });

    // 3 — Email al cliente
    await transporter.sendMail({
      from   : `"GG'SNK" <${process.env.GMAIL_USER}>`,
      to     : cliente.email,
      subject: `✅ Recibimos tu pedido #${result.lastInsertRowid} — GG'SNK`,
      text   : `Hola ${cliente.nombre}!\n\nRecibimos tu pedido y te escribimos en las próximas horas para coordinar el pago.\n\n${formatearPedidoEmail(items, cliente)}\n\n— El equipo de GG'SNK`,
    });

    // 4 — Link WhatsApp
    const waLink = `https://wa.me/${process.env.WHATSAPP_NUMERO}?text=${formatearMensajeWhatsApp(items, cliente)}`;

    res.json({ ok: true, whatsappUrl: waLink, pedidoId: result.lastInsertRowid });

  } catch (err) {
    console.error('Error al procesar pedido:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo procesar el pedido. Intentá de nuevo.' });
  }
});

// ── GET /api/pedidos — listar todos ─────────────────────────
app.get('/api/pedidos', (req, res) => {
  const { estado } = req.query;
  let pedidos;
  if (estado && estado !== 'TODOS') {
    pedidos = db.prepare('SELECT * FROM pedidos WHERE estado = ? ORDER BY id DESC').all(estado);
  } else {
    pedidos = db.prepare('SELECT * FROM pedidos ORDER BY id DESC').all();
  }
  // Parsear productos de JSON a objeto
  pedidos = pedidos.map(p => ({ ...p, productos: JSON.parse(p.productos) }));
  res.json({ ok: true, pedidos });
});

// ── PUT /api/pedido/:id — actualizar estado y tracking ──────
app.put('/api/pedido/:id', (req, res) => {
  const { id }              = req.params;
  const { estado, tracking, notas } = req.body;

  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
  if (!pedido) return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });

  db.prepare(`
    UPDATE pedidos SET
      estado   = COALESCE(?, estado),
      tracking = COALESCE(?, tracking),
      notas    = COALESCE(?, notas)
    WHERE id = ?
  `).run(estado || null, tracking || null, notas || null, id);

  res.json({ ok: true });
});

// ── GET /api/stats — estadísticas para el panel ─────────────
app.get('/api/stats', (req, res) => {
  const total     = db.prepare('SELECT COUNT(*) as n FROM pedidos').get().n;
  const pendiente = db.prepare("SELECT COUNT(*) as n FROM pedidos WHERE estado = 'Pendiente de pago'").get().n;
  const pagado    = db.prepare("SELECT COUNT(*) as n FROM pedidos WHERE estado = 'Pagado'").get().n;
  const encargado = db.prepare("SELECT COUNT(*) as n FROM pedidos WHERE estado = 'Encargo realizado'").get().n;
  const camino    = db.prepare("SELECT COUNT(*) as n FROM pedidos WHERE estado = 'En camino'").get().n;
  const entregado = db.prepare("SELECT COUNT(*) as n FROM pedidos WHERE estado = 'Entregado'").get().n;
  const ingresos  = db.prepare("SELECT SUM(total_usd) as s FROM pedidos WHERE estado != 'Pendiente de pago'").get().s || 0;

  res.json({ ok: true, stats: { total, pendiente, pagado, encargado, camino, entregado, ingresos } });
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
