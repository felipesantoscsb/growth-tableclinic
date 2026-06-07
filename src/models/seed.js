require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  try {
    const users = [
      { name: 'Admin', email: 'adm@tableclinic.com.br', role: 'admin', nutri_name: null },
      { name: 'Evelyn', email: 'evelyn@tableclinic.com.br', role: 'evelyn', nutri_name: null },
      { name: 'Felipe', email: 'felipe@tableclinic.com.br', role: 'editor', nutri_name: null },
      { name: 'Luiza', email: 'luiza@tableclinic.com.br', role: 'editor', nutri_name: null },
      { name: 'Juliana', email: 'juliana@tableclinic.com.br', role: 'nutri', nutri_name: 'Juliana' },
      { name: 'Natalia', email: 'natalia@tableclinic.com.br', role: 'nutri', nutri_name: 'Natalia' },
    ];

    const hash = await bcrypt.hash('table2026', 10);

    for (const u of users) {
      await client.query(
        `INSERT INTO users (name, email, password, role, nutri_name)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO NOTHING`,
        [u.name, u.email, hash, u.role, u.nutri_name]
      );
    }

    // Buscar ID da Evelyn para os cards de seed
    const { rows } = await client.query(`SELECT id FROM users WHERE email='evelyn@tableclinic.com.br'`);
    const evelynId = rows[0]?.id;

    const cards = [
      {
        title: 'Compulsão Noturna',
        pilar: 'tese',
        format: 'carrossel',
        status: 'publicado',
        content: 'A compulsão noturna não começa à noite. Começa no café da manhã que você pulou, na reunião que te estressou, no silêncio que você não conseguiu preencher. À noite, o corpo cobra a conta do dia inteiro.',
      },
      {
        title: 'Alimentação Intuitiva',
        pilar: 'ciencia',
        format: 'reel_curto',
        status: 'publicado',
        content: 'HOOK: Você sabia que seu corpo já sabe o que precisa?\n\nDESENVOLVIMENTO: A alimentação intuitiva não é uma dieta — é um retorno à sua sabedoria interna. A ciência mostra que quando paramos de restringir, o corpo encontra seu equilíbrio natural.\n\nCTA: Salva esse vídeo e me conta: você consegue identificar sua fome física?',
      },
      {
        title: 'Burnout tem gênero',
        pilar: 'provocacao',
        format: 'reel_medio',
        status: 'publicado',
        content: 'HOOK: Ninguém fala sobre isso, mas precisamos falar.\n\nDESENVOLVIMENTO: Burnout tem gênero. Mulheres chegam ao esgotamento de formas diferentes dos homens — e o sistema ainda não foi desenhado para reconhecer isso. A exaustão emocional, o trabalho invisível, a culpa constante. Tudo isso come energia antes mesmo de você abrir o computador.\n\nCTA: Se isso ressoou, compartilha. Alguém precisa ouvir isso hoje.',
      },
    ];

    for (const c of cards) {
      await client.query(
        `INSERT INTO content_cards (title, pilar, format, status, responsible_id, content, generated_by_ai)
         VALUES ($1,$2,$3,$4,$5,$6,false)
         ON CONFLICT DO NOTHING`,
        [c.title, c.pilar, c.format, c.status, evelynId, c.content]
      );
    }

    console.log('Seed completed.');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(console.error);
