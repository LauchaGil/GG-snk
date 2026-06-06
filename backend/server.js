require('dotenv').config();
const express    = require('express');
const { Resend } = require('resend');
const cors       = require('cors');
const { Pool }   = require('pg');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const crypto     = require('crypto');

// ── Auth ─────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'LosTilos03';
const TOKEN_SECRET   = crypto.randomBytes(32).toString('hex');

function generarToken() {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(ADMIN_PASSWORD).digest('hex');
}

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  if (token === generarToken()) return next();
  res.status(401).json({ ok: false, error: 'No autorizado.' });
}

// ── Mercado Pago ─────────────────────────────────────────────
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || '',
});
const mpPreference = new Preference(mpClient);
const mpPayment    = new Payment(mpClient);

// Precios ya vienen en ARS desde el frontend — no se necesita conversión
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://ggsnk.store';
const BACKEND_URL  = process.env.BACKEND_URL  || 'https://ggsnk-backend.onrender.com';

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
    total_ars   REAL    NOT NULL,
    estado      TEXT    NOT NULL DEFAULT 'Pendiente de pago',
    tracking    TEXT,
    notas       TEXT,
    costo       REAL,
    manual      BOOLEAN DEFAULT FALSE
  )
`).then(() => {
  // Por si la tabla ya existía sin estas columnas
  return pool.query(`
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo  REAL;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS manual BOOLEAN DEFAULT FALSE;
  `);
}).then(() => {
  console.log('✅ Tabla pedidos lista');
}).catch(err => {
  console.error('Error al crear tabla:', err.message);
});

// ── Middlewares ──────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://ggsnk.store',
  'https://www.ggsnk.store',
  'https://gg-snk.vercel.app',
];
app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (ej: Postman, Render health checks)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS bloqueado: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
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
      <p style="margin:0;font-size:16px;font-weight:900;font-style:italic;color:#fff;">$${Number(item.price).toLocaleString('es-AR')} <span style="font-size:11px;color:#666;font-weight:400;font-style:normal;">ARS</span></p>
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
        <td style="text-align:right;font-size:24px;font-weight:900;font-style:italic;color:#FF6600;">$${Number(total).toLocaleString('es-AR')} <span style="font-size:12px;color:#666;font-weight:400;font-style:normal;">ARS</span></td>
      </tr>
    </table>
    <p style="margin:12px 0 0;font-size:10px;color:#444;">* Precio en ARS. El pago se procesa vía Mercado Pago.</p>
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
    <p style="margin:0 0 20px;font-size:13px;color:#ccc;line-height:1.7;">Recibimos tu pago y estamos procesando tu encargo. Te avisamos por WhatsApp cuando esté confirmado.</p>
    <p style="margin:0 0 6px;font-size:11px;color:#FF6600;letter-spacing:3px;text-transform:uppercase;">Tu pedido</p>
    <table width="100%" cellpadding="0" cellspacing="0">${filas}</table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:2px solid #FF6600;padding-top:16px;">
      <tr>
        <td style="font-size:13px;color:#999;font-style:italic;">Total referencial</td>
        <td style="text-align:right;font-size:24px;font-weight:900;font-style:italic;color:#FF6600;">$${Number(total).toLocaleString('es-AR')} <span style="font-size:12px;color:#666;font-weight:400;font-style:normal;">ARS</span></td>
      </tr>
    </table>
    <p style="margin:12px 0 0;font-size:10px;color:#444;">* Precio en ARS. El pago se procesa vía Mercado Pago.</p>
    <div style="margin-top:28px;padding:16px;background:#0d0a07;border:1px solid #2a1a08;border-left:3px solid #FF6600;">
      <p style="margin:0;font-size:11px;color:#666;">¿Tenés alguna duda? Escribinos por Instagram o WhatsApp.</p>
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
    `   • Precio: $${Number(item.price).toLocaleString('es-AR')} ARS`
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
    `\u{1F4B5} *TOTAL: $${Number(total).toLocaleString('es-AR')} ARS*\n` +
    `--------------------\n\n` +
    `Quedo a la espera para coordinar el pago \u{1F91D}`
  );
}

// ── POST /api/admin/login ────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: generarToken() });
  } else {
    res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' });
  }
});

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
      `INSERT INTO pedidos (fecha, nombre, email, telefono, provincia, direccion, productos, total_ars)
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

    // 2 — Link WhatsApp (siempre disponible como fallback)
    const waLink = `https://wa.me/${process.env.WHATSAPP_NUMERO}?text=${formatearMensajeWhatsApp(items, cliente)}`;

    // 3 — Crear preferencia de Mercado Pago (si está configurado)
    let initPoint = null;
    if (process.env.MP_ACCESS_TOKEN) {
      try {
        const mpItems = items.map(item => ({
          id          : item.model?.replace(/\s+/g, '-').toLowerCase() || 'zapatilla',
          title       : `${item.brand} ${item.model} — ${item.color} (T.${item.size})`,
          quantity    : 1,
          unit_price  : item.price,   // Ya viene en ARS desde el frontend
          currency_id : 'ARS',
        }));
        const prefData = await mpPreference.create({
          body: {
            items,
            payer       : { name: cliente.nombre, email: cliente.email },
            back_urls   : {
              success : `${FRONTEND_URL}?pago=exitoso&ref=${pedidoId}`,
              failure : `${FRONTEND_URL}?pago=fallido&ref=${pedidoId}`,
              pending : `${FRONTEND_URL}?pago=pendiente&ref=${pedidoId}`,
            },
            auto_return          : 'approved',
            notification_url     : `${BACKEND_URL}/api/webhook/mercadopago`,
            external_reference   : String(pedidoId),
            statement_descriptor : 'GGSNK',
            items                : mpItems,
          },
        });
        initPoint = prefData.init_point;
      } catch (mpErr) {
        console.error('Error al crear preferencia MP:', mpErr.message);
        // Si falla MP no rompemos el flujo, el usuario puede usar WhatsApp
      }
    }

    // 4 — Responder inmediatamente (no esperamos los emails)
    res.json({ ok: true, whatsappUrl: waLink, pedidoId, initPoint });

    // 5 — Emails en segundo plano (no bloquean la respuesta)
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

// ── POST /api/pedido/manual — carga manual desde el panel ───
app.post('/api/pedido/manual', authMiddleware, async (req, res) => {
  const { nombre, producto, costo, venta, estado, notas } = req.body;

  if (!producto || venta == null || venta === '')
    return res.status(400).json({ ok: false, error: 'Faltan el producto y/o el precio de venta.' });

  const ventaNum = Number(venta);
  const costoNum = (costo == null || costo === '') ? null : Number(costo);
  if (Number.isNaN(ventaNum) || (costoNum !== null && Number.isNaN(costoNum)))
    return res.status(400).json({ ok: false, error: 'Costo y venta deben ser números.' });

  const items = [{ brand: 'Manual', model: producto, color: '—', size: '—', price: ventaNum }];

  try {
    const result = await pool.query(
      `INSERT INTO pedidos (fecha, nombre, email, telefono, provincia, direccion, productos, total_ars, costo, estado, notas, manual)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE) RETURNING id`,
      [
        new Date().toISOString(),
        nombre || 'Venta manual',
        '',
        '',
        '',
        '',
        JSON.stringify(items),
        ventaNum,
        costoNum,
        estado || 'Entregado',
        notas || '',
      ]
    );
    res.json({ ok: true, pedidoId: result.rows[0].id });
  } catch (err) {
    console.error('Error al crear pedido manual:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo crear el pedido manual.' });
  }
});

// ── GET /api/pedidos — listar todos ─────────────────────────
app.get('/api/pedidos', authMiddleware, async (req, res) => {
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
app.put('/api/pedido/:id', authMiddleware, async (req, res) => {
  const { id }                             = req.params;
  const { estado, tracking, notas, costo } = req.body;

  try {
    const check = await pool.query('SELECT id FROM pedidos WHERE id = $1', [id]);
    if (check.rows.length === 0)
      return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });

    const costoNum = (costo == null || costo === '') ? null : Number(costo);

    await pool.query(
      `UPDATE pedidos SET
        estado   = COALESCE($1, estado),
        tracking = COALESCE($2, tracking),
        notas    = COALESCE($3, notas),
        costo    = COALESCE($4, costo)
       WHERE id = $5`,
      [estado || null, tracking || null, notas || null, costoNum, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Error al actualizar pedido:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo actualizar el pedido.' });
  }
});

// ── DELETE /api/pedido/:id — eliminar pedido ────────────────
app.delete('/api/pedido/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const check = await pool.query('SELECT id FROM pedidos WHERE id = $1', [id]);
    if (check.rows.length === 0)
      return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });
    await pool.query('DELETE FROM pedidos WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error al eliminar pedido:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo eliminar el pedido.' });
  }
});

// ── GET /api/stats — estadísticas para el panel ─────────────
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows[0]);

    const [total, pendiente, pagado, encargado, camino, entregado, ingresos] = await Promise.all([
      q('SELECT COUNT(*)::int AS n FROM pedidos'),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'Pendiente de pago'"),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'Pagado'"),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'Encargo realizado'"),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'En camino'"),
      q("SELECT COUNT(*)::int AS n FROM pedidos WHERE estado = 'Entregado'"),
      q("SELECT COALESCE(SUM(total_ars), 0) AS s FROM pedidos WHERE estado != 'Pendiente de pago'"),
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

// ── POST /api/webhook/mercadopago — notificaciones de pago ──
app.post('/api/webhook/mercadopago', async (req, res) => {
  // MP requiere respuesta 200 inmediata para no reintentar
  res.status(200).send('OK');

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;

  try {
    const paymentData = await mpPayment.get({ id: data.id });
    if (paymentData.status !== 'approved') return;

    const pedidoId = parseInt(paymentData.external_reference);
    if (!pedidoId) return;

    // Marcar pedido como pagado
    await pool.query(
      `UPDATE pedidos SET estado = 'Pagado' WHERE id = $1 AND estado = 'Pendiente de pago'`,
      [pedidoId]
    );
    console.log(`✅ Pago aprobado — Pedido #${pedidoId}`);

    // Obtener datos del pedido para enviar emails
    const result = await pool.query('SELECT * FROM pedidos WHERE id = $1', [pedidoId]);
    if (result.rows.length === 0) return;

    const p     = result.rows[0];
    const items = JSON.parse(p.productos);
    const cliente = {
      nombre   : p.nombre,
      email    : p.email,
      telefono : p.telefono,
      provincia: p.provincia,
      direccion: p.direccion,
    };

    // Emails de confirmación de pago
    resend.emails.send({
      from   : `GG'SNK Pedidos <pedidos@ggsnk.store>`,
      to     : process.env.EMAIL_DESTINO,
      subject: `💸 Pago confirmado — Pedido #${pedidoId} (${cliente.nombre})`,
      html   : htmlEmailTienda(items, cliente, pedidoId),
    }).catch(err => console.error('Error email tienda (webhook):', err.message));

    resend.emails.send({
      from   : `GG'SNK <pedidos@ggsnk.store>`,
      to     : cliente.email,
      subject: `✅ Pago recibido — Pedido #${pedidoId} — GG'SNK`,
      html   : htmlEmailCliente(items, cliente, pedidoId),
    }).catch(err => console.error('Error email cliente (webhook):', err.message));

  } catch (err) {
    console.error('Error en webhook MP:', err.message);
  }
});

// ── GET /api/seguimiento/:id — estado público del pedido ─────
app.get('/api/seguimiento/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, fecha, productos, total_ars, estado, tracking FROM pedidos WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0)
      return res.json({ ok: false, error: 'Pedido no encontrado. Revisá el número.' });
    const p         = result.rows[0];
    const productos = JSON.parse(p.productos);
    res.json({
      ok: true,
      pedido: {
        id        : p.id,
        fecha     : p.fecha,
        estado    : p.estado,
        tracking  : p.tracking,
        total_ars : p.total_ars,
        cantidad  : productos.length,
        productos : productos.map(i => ({ brand: i.brand, model: i.model, color: i.color, size: i.size })),
      },
    });
  } catch (err) {
    console.error('Error seguimiento:', err.message);
    res.status(500).json({ ok: false, error: 'Error al buscar el pedido.' });
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
    : p.fecha,
        estado    : p.estado,
        tracking  : p.tracking,
        total_ars : p.total_ars,
        cantidad  : productos.length,
        productos : productos.map(i => ({ brand: i.brand, model: i.model, color: i.color, size: i.size })),
      },
    });
  } catch (err) {
    console.error('Error seguimiento:', err.message);
    res.status(500).json({ ok: false, error: 'Error al buscar el pedido.' });
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
    : p.fecha,
        estado    : p.estado,
        tracking  : p.tracking,
        total_ars : p.total_ars,
        cantidad  : productos.length,
        productos : productos.map(i => ({ brand: i.brand, model: i.model, color: i.color, size: i.size })),
      },
    });
  } catch (err) {
    console.error('Error seguimiento:', err.message);
    res.status(500).json({ ok: false, error: 'Error al buscar el pedido.' });
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
    : p.fecha,
        estado    : p.estado,
        tracking  : p.tracking,
        total_ars : p.total_ars,
        cantidad  : productos.length,
        productos : productos.map(i => ({ brand: i.brand, model: i.model, color: i.color, size: i.size })),
      },
    });
  } catch (err) {
    console.error('Error seguimiento:', err.message);
    res.status(500).json({ ok: false, error: 'Error al buscar el pedido.' });
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
