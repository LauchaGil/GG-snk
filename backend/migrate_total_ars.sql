-- Migración: renombrar columna total_usd → total_ars
-- Correr UNA SOLA VEZ en la base de datos de producción (Render/PostgreSQL)
--
-- Cómo ejecutarlo en Render:
--   1. Ir a tu base de datos en Render → "Connect" → "PSQL Command"
--   2. Pegar y ejecutar el comando de abajo
--   3. Listo. El servidor puede seguir corriendo mientras se hace el rename.

ALTER TABLE pedidos RENAME COLUMN total_usd TO total_ars;
