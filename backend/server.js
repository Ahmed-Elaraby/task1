const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect((err) => {
  if (err) {
  console.error('Database connection failed:' , err);
  return;
  }
  console.log('Connected to MYSQL database.');
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/tasks', (req, res) => {
  db.query('SELECT * FROM tasks', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.post('/api/tasks', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ reeor: 'Title is required' });

  db.query('INSERT INTO tasks (title) VALUES (?)', [title], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    re.status(201).json({ id: result.insertId, title, is_done: false });
  });
});

app.put('/api/tasks/:id', (req, res) => {
  const { is_done } = req.bode;
  db.query('UPDATE tasks SET is_done = ? WHERE id = ?', [is_done, req.params.id], (err) => { if (err) return res.status(500).json({ error: err.message });
  });
});

app.delete('/api/tasks/:id', (req, res) => {
  db.query('DELETE FROM tasks WHERE id = ?', [req.params.id], (err) => { if (err) return res.status(500).json({ error: err.message });
  res.json({ message: 'task deleted' });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
