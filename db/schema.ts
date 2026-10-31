import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Story bibles: one per book. The source of truth for characters, concepts, metaphors.
export const bibles = sqliteTable("bibles", {
  id: text("id").primaryKey(),
  bookSlug: text("book_slug").notNull().unique(),
  bookTitle: text("book_title").notNull(),
  bigIdea: text("big_idea").notNull(),
  setting: text("setting").notNull(),
  // JSON: characters[], locations[], conceptLadder[], arc{}, runningGags[], vocab[]
  data: text("data").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Books: the final products. status=complete shows on the public storefront.
export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  bibleId: text("bible_id").references(() => bibles.id),
  status: text("status").notNull().default("draft"), // draft | in_progress | complete
  price: integer("price").notNull().default(0), // cents
  description: text("description"),
  // R2 keys for the PDFs
  pictureBookKey: text("picture_book_key"),
  coloringBookKey: text("coloring_book_key"),
  coverKey: text("cover_key"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Chapters: story chapters within a book.
export const chapters = sqliteTable("chapters", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull().references(() => books.id),
  storyChapter: text("story_chapter").notNull(), // S1, S2, ...
  storyTitle: text("story_title").notNull(),
  realConcept: text("real_concept"),
  takeaway: text("takeaway"),
  // JSON: pages[{characters[], imagePrompt, storyText}], newStorySoFar
  plan: text("plan"),
  status: text("status").notNull().default("planned"), // planned | art_done | complete
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Characters: the reusable character library.
export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  species: text("species").notNull(),
  source: text("source").notNull(), // cover | library | invented
  personality: text("personality"), // JSON array
  visual: text("visual").notNull(), // image-safe description
  realMapsTo: text("real_maps_to"),
  // R2 keys for the art
  jpgKey: text("jpg_key"),
  svgKey: text("svg_key"),
  createdAt: integer("created_at").notNull(),
});
