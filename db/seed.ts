import { db } from 'void/db';
import { bibles, characters, books } from '@schema';
import bibleData from './seed-bible.json';

export async function seed() {
  const now = Date.now();
  
  // Docker bible
  const bibleId = 'bible-docker';
  await db.insert(bibles).values({
    id: bibleId,
    bookSlug: 'docker',
    bookTitle: bibleData.bookTitle,
    bigIdea: bibleData.bigIdea,
    setting: bibleData.setting,
    data: JSON.stringify(bibleData),
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  
  // Characters
  for (const c of bibleData.characters) {
    await db.insert(characters).values({
      id: `char-${c.name.toLowerCase()}`,
      name: c.name,
      species: c.species,
      source: c.source,
      personality: JSON.stringify(c.personality),
      visual: c.visual,
      realMapsTo: c.realMapsTo,
      createdAt: now,
    }).onConflictDoNothing();
  }
  
  // Book
  await db.insert(books).values({
    id: 'book-docker',
    slug: 'docker',
    title: bibleData.bookTitle,
    bibleId,
    status: 'in_progress',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  
  console.log('Seeded Docker bible, 3 characters, and book.');
}
