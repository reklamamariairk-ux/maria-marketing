// Справочник каналов маркетинга. Не редактируется через API в этой версии —
// каналы засеваются миграцией. Если нужен новый — добавить миграцию.

const { pool } = require('../lib/db');

async function list(_req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, name, category, api_integration, is_active, notes
       FROM mk_channels
       WHERE is_active = true
       ORDER BY category, name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { list };
