// Seeds the notes "database" (a JSON file).
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync(new URL('data/', import.meta.url), { recursive: true });
writeFileSync(new URL('data/notes.json', import.meta.url), `${JSON.stringify([{ title: 'Welcome', text: 'Your first note', updatedAt: '2026-01-01' }])}\n`);
console.log('Database reset');
