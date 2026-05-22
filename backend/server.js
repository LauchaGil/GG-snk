require('dotenv').config();
const express    = require('express');
const { Resend } = require('resend');
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

// ── Resend (email API) ───────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Helpers ──────────────────────────────────────────────────
function emailHTML({ titulo, encabezado, contenido, footer }) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0a07;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0a07;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- HEADER -->
        <tr>
          <td style="background:#080502;border:1px solid #2a1a08;padding:32px 40px;text-align:center;border-bottom:3px solid #FF6600;">
            <p style="margin:0;font-size:42px;font-weight:900;font-style:italic;color:#FF6600;letter-spacing:-1px;text-transform:uppercase;">GG'SNK</p>
            <p style="margin:6px 0 0;font-size:11px;color:#666;letter-spacing:4px;text-transform:uppercase;">Retro Runners Importados</p>
          </td>
        </tr>

        <!-- TITULO -->
        <tr>
          <td style="background:#FF6600;padding:14px 40px;text-align:center;">
            <p style="margin:0;font-size:13px;font-weight:900;color:#080502;letter-spacing:3px;text-transform:uppercase;">${titulo}</p>
          </td>
        </tr>

        <!-- CONTENIDO -->
        <tr>
          <td style="background:#120b05;border:1px solid #2a1a08;border-top:none;padding:32px 40px;">
            <p style="margin:0 0 24px;font-size:16px;color:#fff;">${encabezado}</p>
            ${contenido}
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#080502;border:1px solid #2a1a08;border-top:3px solid #2a1a08;padding:20px 40px;text-align:center;">
            <p style="margin:0;font-size:10px;color:#444;letter-spacing:3px;text-transform:uppercase;">${footer}</p>
            <p style="margin:8px 0 0;font-size:10px;color:#333;letter-spacing:2px;text-transform:uppercase;">ggsnk.store · City Bell, Argentina</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function emailFilaProducto(item) {
  return `
  <tr>
    <td style="padding:12px 0;border-bottom:1px solid #2a1a08;">
      <p style="margin:0;font-size:11px;color:#FF6600;letter-spacing:2px;text-transform:uppercase;">${item.brand}</p>
      <p style="margin:2px 0;font-size:15px;font-weight:700;color:#fff;">${item.model} — ${item.color}</p>
      <p style="margin:2px 0;font-size:11px;color:#666;">Talle ${item.size} EUR</p>
    </td>
    <td style="padding:12px 0;border-bottom:1px solid #2a1a08;text-align:right;vertical-align:top;">
      <p style="margin:0;font-size:16px;font-weight:900;font-style:italic;color:#fff;">$${item.price} <span style="font-size:11px;color:#666;font-weight:400;font-style:normal;">USD</span></p>
    </td>
  </tr>`;
}

function htmlEmailTienda(items, cliente, pedidoId) {
  const total = items.reduce((sum, i) => sum + i.price, 0);
  const filas = items.map(emailFilaProducto).join('');
  const contenido = `
    <p style="margin:0 0 6px;font-size:11px;color:#FF6600;letter-spacing:3px;text-transform:uppercase;">Cliente</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;background:#0d0a07;border:1px solid #2a1a08;padding:16px;">
      <tr><td style="font-size:12px;color:#999;padding:3px 0;">Nombre</td><td style="font-size:12px;color:#fff;text-align:right;">${cliente.nombre}</td></tr>
      <tr><td style="font-size:12px;color:#999;padding:3px 0;">Email</td><td style="font-size:12px;color:#fff;text-align:right;">${cliente.email}</td></tr>
      <tr><td style="font-size:12px;color:#999;padding:3px 0;">Teléfono</td><td style="font-size:12px;color:#fff;text-align:right;">${cliente.telefono || 'No indicado'}</td></tr>
      <tr><td style="font-size:12px;color:#999;padding:3px 0;">Provincia</td><td style="font-size:12px;color:#fff;text-align:right;">${cliente.provincia || 'No indicada'}</td></tr>
      <tr><td style="font-size:12px;color:#999;padding:3px 0;">Dirección</td><td style="font-size:12px;color:#fff;text-align:right;">${cliente.direccion || 'No indicada'}</td></tr>
    </table>
    <p style="margin:0 0 6px;font-size:11px;color:#FF6600;letter-spacing:3px;text-transform:uppercase;">Productos</p>
    <table width="100%" cellpadding="0" cellspacing="0">${filas}</table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:2px solid #FF6600;padding-top:16px;">
      <tr>
        <td style="font-size:13px;color:#999;font-style:italic;">Total referencial</td>
        <td style="text-align:right;font-size:24px;font-weight:900;font-style:italic;color:#FF6600;">$${total} <span style="font-size:12px;color:#666;font-weight:400;font-style:normal;">USD</span></td>
      </tr>
    </table>
    <p style="margin:12px 0 0;font-size:10px;color:#444;">* Precio en ARS se cotiza al confirmar el encargo.</p>
  `;
  return emailHTML({
    titulo: `Nuevo pedido #${pedidoId}`,
    encabezado: `Nuevo encargo de <strong style="color:#FF6600;">${cliente.nombre}</strong>`,
    contenido,
    footer: `Pedido #${pedidoId} · ${new Date().toLocaleDateString('es-AR')}`,
  });
}

function htmlEmailCliente(items, cliente, pedidoId) {
  const total = items.reduce((sum, i) => sum + i.price, 0);
  const filas = items.map(emailFilaProducto).join('');
  const contenido = `
    <p style="margin:0 0 20px;font-size:13px;color:#ccc;line-height:1.7;">Recibimos tu encargo y te escribimos en las próximas <strong style="color:#fff;">48 horas</strong> para coordinar el pago y confirmar disponibilidad.</p>
    <p style="margin:0 0 6px;font-size:11px;color:#FF6600;letter-spacing:3px;text-transform:uppercase;">Tu pedido</p>
    <table width="100%" cellpadding="0" cellspacing="0">${filas}</table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:2px solid #FF6600;padding-top:16px;">
      <tr>
        <td style="font-size:13px;color:#999;font-style:italic;">Total referencial</td>
        <td style="text-align:right;font-size:24px;font-weight:900;font-style:italic;color:#FF6600;">$${total} <span style="font-size:12px;color:#666;font-weight:400;font-style:normal;">USD</span></td>
      </tr>
    </table>
    <p style="margin:12px 0 0;font-size:10px;color:#444;">* Precio en ARS se cotiza al confirmar el encargo.</p>
    <div style="margin-top:28px;padding:16px;background:#0d0a07;border:1px solid #2a1a08;border-left:3px solid #FF6600;">
      <p style="margin:0;font-size:11px;color:#666;">Si no recibís respuesta en 48hs escribinos directo por Instagram o WhatsApp.</p>
    </div>
  `;
  return emailHTML({
    titulo: `Encargo confirmado #${pedidoId}`,
    encabezado: `¡Gracias, <strong style="color:#FF6600;">${cliente.nombre}</strong>!`,
    contenido,
    footer: `Ref #${pedidoId} · ${cliente.email}`,
  });
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
    `\u{1F6D2} *NUEVO PEDIDO — GG'SNK*\n` +
    `--------------------\n\n` +
    `\u{1F464} *Datos del cliente*\n` +
    `Nombre: ${cliente.nombre}\n` +
    `Provincia: ${cliente.provincia || 'No indicada'}\n\n` +
    `\u{1F4E6} *Productos*\n\n` +
    `${lineas}\n\n` +
    `--------------------\n` +
    `\u{1F4B5} *TOTAL: $${total} USD*\n` +
    `--------------------\n\n` +
    `Quedo a la espera para coordinar el pago \u{1F91D}`
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
    resend.emails.send({
      from   : `GG'SNK Pedidos <pedidos@ggsnk.store>`,
      to     : process.env.EMAIL_DESTINO,
      subject: `Nuevo pedido #${pedidoId} — ${cliente.nombre}`,
      html   : htmlEmailTienda(items, cliente, pedidoId),
    }).catch(err => console.error('Error email tienda:', err.message));

    resend.emails.send({
      from   : `GG'SNK <pedidos@ggsnk.store>`,
      to     : cliente.email,
      subject: `Recibimos tu pedido #${pedidoId} — GG'SNK`,
      html   : htmlEmailCliente(items, cliente, pedidoId),
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
