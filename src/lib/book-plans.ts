import { captureApprovalRevision, assertApprovedAssembly, approvedPages } from './approval-identity';
import type { BookRevision } from '../../packages/core/src/book-revision';
import { readPlanInventory } from '../../packages/core/src/book-revision';
// A book's page list from its chapter plans in storage
// (books/{slug}/plans/S{n}.json, the same plans the editor and
// the factory work from). The publish gate and the readiness
// page count pages from here. (This replaces a leftover where
// the publish route compared every book's approvals against a
// static import of one book's chapters; caught 2026-10-31 when
// CG asked how QC gets marked good and the approvals table
// turned out to be empty and the total was another book's.)

export interface BookPageRef {
  chapter: number;
  page: number;
}

export async function listBookPages(books: any, slug: string): Promise<BookPageRef[]> {
  return (await readPlanInventory(books, slug)).pages.map(({ chapter, page }) => ({ chapter, page }));
}

export async function countBookPages(books: any, slug: string): Promise<number> {
  return (await listBookPages(books, slug)).length;
}

export async function countApprovedPages(db: any, books: any, slug: string): Promise<number> {
  const { manifest } = await captureApprovalRevision(db, books, slug);
  return countApprovedInventory(db, manifest);
}
export async function countApprovedInventory(db: any, manifest: BookRevision): Promise<number> {
  return (await approvedPages(db, manifest)).length;
}

export interface BookQcState {
  totalPages: number | null;
  approvedCount: number | null;
  complete: boolean;
  label: string;
  revision?: string;
}

/** Read the inventory once. An unavailable fact must never look like a zero. */
export async function getBookQcState(db: any, books: any, slug: string,
  given?: Awaited<ReturnType<typeof captureApprovalRevision>>): Promise<BookQcState> {
  let pages: BookPageRef[];
  // A caller-held snapshot's inventory is the same plan read
  // listBookPages performs; reuse it instead of re-reading plans.
  if (given?.inventory?.pages?.length) pages = given.inventory.pages.map(p => ({ chapter: p.chapter, page: p.page }));
  else try { pages = await listBookPages(books, slug); }
  catch {
    return { totalPages: null, approvedCount: null, complete: false,
      label: 'Unverified: page inventory could not be read. Retry when the book plans are available.' };
  }
  try {
    const snapshot = given ?? await captureApprovalRevision(db, books, slug);
    const { manifest } = snapshot;
    // Verify the assembly against the snapshot already captured
    // and hash-checked here, instead of deep-capturing (byte
    // hashing) the whole book again per edition on every page
    // load (2026-11-11: the readiness page took ~a minute). The
    // publish gate keeps its own independent deep verification;
    // this read path only labels state, and anything unprovable
    // still lands in the unverified label below.
    await assertApprovedAssembly(books, manifest,
      { inventory: snapshot.inventory, observations: snapshot.observations });
    const approvedCount = await countApprovedInventory(db, manifest);
    return { totalPages: pages.length, approvedCount, revision: manifest.revision, complete: pages.length > 0 && approvedCount === pages.length,
      label: `${approvedCount} of ${pages.length} pages approved.` };
  } catch {
    return { totalPages: pages.length, approvedCount: null, complete: false,
      label: 'Unverified: page approvals could not be read. Retry when approvals are available.' };
  }
}
